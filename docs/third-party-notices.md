# Third-party components and source-only publication

GamePilot 0.15.13 publishes original application, bridge, adapter and test source under AGPL-3.0-only. This repository does not bundle installed npm dependencies, Electron, DSH / Node binaries, Maa native binaries, OCR models, emulator / ADB software, game screenshots or recognition templates. Download scripts are provided for some local dependencies; they do not change upstream licenses.

## Pinned components

| Component | Version / source | License and retained material |
| --- | --- | --- |
| MaaCore / MaaAssistantArknights | [v6.17.5](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/v6.17.5); archive hash in `games/arknights/engine-contract.json` | [AGPL-3.0](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/v6.17.5/LICENSE); local copy `packages/maa-bridge/MAA-LICENSE.txt` |
| MaaFramework / `@maaxyz/maa-node` | [v5.13.0](https://github.com/MaaXYZ/MaaFramework/tree/v5.13.0), fixed by root npm lock | [LGPL-3.0](https://github.com/MaaXYZ/MaaFramework/blob/v5.13.0/LICENSE.md); native dependencies are a separate inventory |
| DeepSeek Harness core / SDK / session packages | 0.2.1-alpha.1; reviewed [commit 5badb15009ae1756c3afe0ae0cef1faafc290ccc](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc); isolated npm lock | [MIT, Copyright 2026 DeepSeek](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/LICENSE); transitive packages retain their own licenses |
| DSH Node runtime | Windows x64 v24.21.0; executable and license hashes in `integrations/deepseek-harness/runtime/node-runtime.json` | Node's complete license and included dependency notices must accompany any redistributed runtime; executable is not included here |
| Electron | 44.3.0, root npm lock; [upstream source](https://github.com/electron/electron/tree/v44.3.0) | MIT plus Chromium / other dependency notices; preserve `LICENSE` and `LICENSES.chromium.html` from the actual distribution |
| React / React DOM / Scheduler | React and React DOM 19.3.0, transitive versions in root lock; [React source](https://github.com/facebook/react) | MIT; preserve installed package notices when bundling |
| Lucide React | 1.46.0, root lock; [upstream source](https://github.com/lucide-icons/lucide) | ISC; preserve the installed package license |
| CC Switch theme reference | [revision 1ee2fdc3a791f1e73476c631c7ab7ce8fac0638f](https://github.com/farion1231/cc-switch/tree/1ee2fdc3a791f1e73476c631c7ab7ce8fac0638f) | MIT, Copyright 2025 Jason Young; retained in [CC-Switch-MIT.txt](CC-Switch-MIT.txt). No CC Switch backend or branding is bundled. |
| MaaCommonAssets OCR conversion assets | [revision dabcd4681ac990dc4361de26416d986abd80e4aa](https://github.com/MaaXYZ/MaaCommonAssets/tree/dabcd4681ac990dc4361de26416d986abd80e4aa/OCR/ppocr_v4/zh_cn) | MIT; retained in [MaaCommonAssets-MIT.txt](../games/onmyoji/resources/licenses/MaaCommonAssets-MIT.txt) |
| PaddleOCR PP-OCRv4 model origin | [PaddleOCR release/2.7](https://github.com/PaddlePaddle/PaddleOCR/tree/release/2.7); model and dictionary details in the OCR README, download hashes in `scripts/setup-ocr.mjs` | Apache-2.0; retained in [PaddleOCR-Apache-2.0.txt](../games/onmyoji/resources/licenses/PaddleOCR-Apache-2.0.txt) |
| .NET runtime for the C# bridge | Target framework `net8.0`; SDK / runtime patch version depends on the build environment | [.NET MIT license](../packages/maa-bridge/DOTNET-LICENSE.txt) and [third-party notices](../packages/maa-bridge/DOTNET-THIRD-PARTY-NOTICES.txt); check these against the exact self-contained runtime you distribute |

The npm locks also cover build tools and transitive dependencies. A package's metadata is useful provenance, but is not a substitute for all applicable license texts and source obligations.

## Source and modifications

The MaaCore bridge source is `packages/maa-bridge/Program.cs`, with its project file and protocol description in the same directory. It calls the public C ABI described by the fixed MAA release. The bridge runs separately for execution isolation; this does not establish a license exemption.

`scripts/setup-maacore.mjs` obtains and checks the official release archive. `scripts/build-bridge.mjs` copies selected native files and resources, then applies `games/arknights/maa-startup-patch.mjs` to the generated task resource. The original archive remains unchanged. Generated resources are modified material and carry `gamepilot-resource-patches.json`; retain the patch source and build instructions when distributing them.

The original DSH packages are not modified. GamePilot adds `launcher.mjs`, `plugin.mjs` and a Cordis overlay in `integrations/deepseek-harness/runtime`. Its independent lock preserves package versions and integrity values. Runtime sessions, credentials and caches are not publication inputs.

## Additional binary-distribution work

This source publication does not include a combined portable release or certify its redistribution readiness. Before distributing a binary build, determine and satisfy the obligations of the exact included versions, including suitable corresponding-source access where required. A generic repository link is not asserted to be a complete corresponding-source delivery.

Known inventory boundaries include:

- MaaFramework native packages contain further components such as OpenCV, DirectML, ViGEmClient, Android agents and a demo plugin. The repository's previous packaging helper is not an exhaustive version-matched inventory for all embedded components.
- `scripts/portable-licenses.mjs` pins notices for [FastDeploy](https://github.com/MaaXYZ/FastDeploy/tree/e962983da6daba7d0c12f6bf5f8ff7173be70982) (Apache-2.0) and [ONNX Runtime v1.19.2](https://github.com/microsoft/onnxruntime/tree/v1.19.2) (MIT and ThirdPartyNotices), using the [MaaDeps v2.12.6](https://github.com/MaaXYZ/MaaDeps/tree/v2.12.6) version relationship. These notices do not cover every native component by themselves.
- DSH dependencies include LibreOffice kit packages (MPL-2.0) and sharp / libvips components (including LGPL-3.0-or-later). Disabling their model tools does not remove files copied into a distribution or erase their licenses.
- The DSH setup helper collects top-level license files and writes a notice inventory. Some dependencies may have no collected file; successful setup is not proof that the complete notice/source inventory is finished.
- Keep Electron / Chromium notices, Node's full license, .NET notices, bundled JavaScript notices, original copyrights, modification notices and exact dependency provenance with the appropriate distribution.

GamePilot does not prohibit replacing interface-compatible LGPL library components or reverse engineering for debugging modifications to those components. A distributor must also choose a compliant delivery and linking arrangement; do not replace native files while an executor is running.

## Game assets and external programs

Game names, artwork and trademarks belong to their respective owners and are not relicensed by GamePilot. This source publication excludes the game's screenshot-derived templates and reference images. User-provided assets need independent rights and compatibility verification; see [getting started](getting-started.md#游戏模板缺口).

The emulator, game clients, ADB and Microsoft Visual C++ runtime are supplied separately. GamePilot's project license grants no rights to redistribute those products. It also does not imply endorsement by any upstream project or game publisher.
