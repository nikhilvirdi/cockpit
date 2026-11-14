# Direct analyzer fixture

This source-only workspace exercises all seven languages. See the repository README for the analyzer image setup. The Go module uses a local subpackage, and the sibling nested-go fixture tests a local module replacement. The Java fixture uses conventional package paths. Python covers Unicode and relative aliases. The C and C++ sources share a header and include pointer, virtual, overloaded, template, and construction cases.

Set `COCKPIT_TEST_ANALYZER_IMAGE` to the built image ID and run `npm -w server test` for the real-tool integration tests. The optional timeout test accepts `COCKPIT_TEST_TIMEOUT_IMAGE`, a trusted test image whose entrypoint reads `/workspace/mode`, exits nonzero in failure mode, and sleeps for at least 60 seconds in sleep mode.
