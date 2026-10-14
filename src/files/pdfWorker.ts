// pdf.js worker entry: install the Map upsert polyfill before the worker code runs.
import './mapPolyfill'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
