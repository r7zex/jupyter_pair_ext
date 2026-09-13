# Iroh native transport

This extension includes native Iroh libraries from the official
[`@number0/iroh` packages](https://github.com/n0-computer/iroh-ffi).
They are distributed under the MIT OR Apache-2.0 license.

Copyright 2025 N0, INC. The upstream license texts are included alongside
this notice in `iroh-LICENSE-MIT.txt` and `iroh-LICENSE-APACHE.txt`.
The unmodified binaries come from the official npm packages.

The build verifies each native package against package-lock.json SHA-512
integrity and records the packaged binary SHA-256 in media/native/manifest.json.
No native library is downloaded when the extension runs.
