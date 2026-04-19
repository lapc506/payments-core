// =============================================================================
// gRPC health checking protocol (`grpc.health.v1.Health`).
// -----------------------------------------------------------------------------
// Minimal inline implementation so consumers can run `grpc_health_probe`
// (or any client implementing the Health protocol) against the sidecar
// without pulling in the `grpc-health-check` npm package. The protocol is
// two RPCs:
//
//   Check(HealthCheckRequest) returns (HealthCheckResponse);
//   Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
//
// The request carries a `service` field — empty string = "overall server
// health". The response carries `status` ∈ {UNKNOWN, SERVING, NOT_SERVING,
// SERVICE_UNKNOWN}.
//
// We implement `Check` synchronously against a mutable map and leave
// `Watch` as a one-shot that emits the current status and stays open. The
// server wires both: status flips between SERVING and NOT_SERVING at
// startup and during graceful shutdown.
// =============================================================================

import * as grpc from '@grpc/grpc-js';

export enum ServingStatus {
  UNKNOWN = 0,
  SERVING = 1,
  NOT_SERVING = 2,
  SERVICE_UNKNOWN = 3,
}

interface HealthCheckRequest {
  service: string;
}

interface HealthCheckResponse {
  status: ServingStatus;
}

/**
 * Minimal service definition for `grpc.health.v1.Health`. Proto-free: we
 * serialize the two messages by hand because the wire format is trivially
 * small (one enum int + one string). Using varint encoding — 1 byte per
 * field tag + 1-2 bytes per value.
 */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = v >>> 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeHealthCheckResponse(r: HealthCheckResponse): Buffer {
  // field 1, wire type 0 (varint): tag = (1 << 3) | 0 = 0x08
  const tag = Buffer.from([0x08]);
  const value = encodeVarint(r.status);
  return Buffer.concat([tag, value]);
}

function decodeHealthCheckRequest(buf: Buffer): HealthCheckRequest {
  let offset = 0;
  let service = '';
  while (offset < buf.length) {
    const tag = buf[offset++];
    if (tag === undefined) break;
    const fieldNo = tag >> 3;
    const wireType = tag & 0x07;
    if (fieldNo === 1 && wireType === 2) {
      // length-delimited string
      let len = 0;
      let shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        if (b === undefined) break;
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      service = buf.slice(offset, offset + len).toString('utf8');
      offset += len;
    } else {
      // unknown field — bail out; proto3 tolerates unknown fields
      break;
    }
  }
  return { service };
}

const HealthServiceDefinition: grpc.ServiceDefinition = {
  Check: {
    path: '/grpc.health.v1.Health/Check',
    requestStream: false,
    responseStream: false,
    requestSerialize: (): Buffer => Buffer.alloc(0),
    requestDeserialize: (buf: Buffer): HealthCheckRequest =>
      decodeHealthCheckRequest(buf),
    responseSerialize: (r: HealthCheckResponse): Buffer =>
      encodeHealthCheckResponse(r),
    responseDeserialize: (): HealthCheckResponse => ({ status: ServingStatus.UNKNOWN }),
  },
  Watch: {
    path: '/grpc.health.v1.Health/Watch',
    requestStream: false,
    responseStream: true,
    requestSerialize: (): Buffer => Buffer.alloc(0),
    requestDeserialize: (buf: Buffer): HealthCheckRequest =>
      decodeHealthCheckRequest(buf),
    responseSerialize: (r: HealthCheckResponse): Buffer =>
      encodeHealthCheckResponse(r),
    responseDeserialize: (): HealthCheckResponse => ({ status: ServingStatus.UNKNOWN }),
  },
};

export class HealthService {
  private readonly statuses = new Map<string, ServingStatus>();

  constructor(initial: ServingStatus = ServingStatus.NOT_SERVING) {
    this.statuses.set('', initial);
  }

  setStatus(service: string, status: ServingStatus): void {
    this.statuses.set(service, status);
  }

  /**
   * Flip the overall server ('') status. Sidecar callers use this on
   * startup (→ SERVING) and during SIGTERM draining (→ NOT_SERVING).
   */
  setServingStatus(status: ServingStatus): void {
    this.setStatus('', status);
  }

  private resolve(service: string): ServingStatus {
    return this.statuses.get(service) ?? ServingStatus.SERVICE_UNKNOWN;
  }

  register(server: grpc.Server): void {
    server.addService(HealthServiceDefinition, {
      Check: (
        call: grpc.ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
        callback: grpc.sendUnaryData<HealthCheckResponse>,
      ) => {
        const status = this.resolve(call.request.service);
        callback(null, { status });
      },
      Watch: (
        call: grpc.ServerWritableStream<HealthCheckRequest, HealthCheckResponse>,
      ) => {
        // One-shot emission; callers reconnect on transport errors. Full
        // watch semantics (push on every status change) land when we adopt
        // the upstream `grpc-health-check` package.
        call.write({ status: this.resolve(call.request.service) });
        call.end();
      },
    });
  }
}
