# GamePilot notices

GamePilot 0.15.13 is published as a source-only project at [We-First-Met-as-Flowers-Bloomed/GamePilot](https://github.com/We-First-Met-as-Flowers-Bloomed/GamePilot).

Original GamePilot source code and original project documentation are offered under **AGPL-3.0-only**. The complete license is in [LICENSE](LICENSE). The license text is reproduced verbatim; its Free Software Foundation copyright notice is not a claim of authorship of GamePilot.

Third-party code, documentation excerpts, dependencies, model files and license texts retain their own copyright notices and licenses. The project license does not relicense those materials. See [third-party notices](docs/third-party-notices.md) for pinned sources and the scope of this publication.

In particular:

- MaaCore / MaaAssistantArknights v6.17.5 is AGPL-3.0 software. The original GamePilot C# bridge uses its public ABI. Separate-process integration is not presented as an exemption from license obligations.
- MaaFramework v5.13.0 is LGPL-3.0 software. It is distinct from MaaCore.
- The pinned DeepSeek Harness core and SDK packages are MIT-licensed. Their transitive dependencies have additional licenses, including MPL and LGPL; they are not all covered by MIT.
- The interface theme references CC Switch at revision `1ee2fdc3a791f1e73476c631c7ab7ce8fac0638f`. Preserve [its MIT notice](docs/CC-Switch-MIT.txt), including Copyright (c) 2025 Jason Young.
- OCR preparation downloads pinned MaaCommonAssets / PaddleOCR assets. Preserve the [MaaCommonAssets MIT text](games/onmyoji/resources/licenses/MaaCommonAssets-MIT.txt) and [PaddleOCR Apache-2.0 text](games/onmyoji/resources/licenses/PaddleOCR-Apache-2.0.txt).
- The self-contained .NET bridge build must retain the [.NET license](packages/maa-bridge/DOTNET-LICENSE.txt) and [third-party notices](packages/maa-bridge/DOTNET-THIRD-PARTY-NOTICES.txt), together with notices matching the runtime actually distributed.

No game screenshots or game-derived recognition templates are included in this source publication. Game artwork, names and trademarks remain with their respective owners. Users must obtain their own compatible recognition assets and any permissions needed for their use or redistribution. Capturing an image does not by itself establish a right to relicense the underlying game artwork.

The source contains a patch script for an MAA startup-announcement resource. `scripts/build-bridge.mjs` applies `games/arknights/maa-startup-patch.mjs` to a generated copy of the upstream task resource and writes a patch record. The downloaded archive is unchanged; generated patched resources must not be described as wholly unmodified upstream content.

This repository does not provide a complete corresponding-source bundle or an exhaustive notice inventory for a combined portable binary distribution. Publishing this source repository is not a certification that an independently assembled binary package meets every third-party redistribution requirement. Preserve source, modifications, licenses and build information appropriate to the exact components you distribute.
