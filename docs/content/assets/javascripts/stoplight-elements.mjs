// Stoplight Elements loader.
// Registers the `<elements-api>` Web Component and injects its stylesheet.
// Embedded by `extra_javascript` in `mkdocs.yml` so every page that uses
// `<elements-api>` gets the component without per-page imports.
import 'https://unpkg.com/@stoplight/elements/web-components.min.js';
import 'https://unpkg.com/@stoplight/elements/styles.min.css';
