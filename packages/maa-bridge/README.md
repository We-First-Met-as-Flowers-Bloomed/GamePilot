# GamePilot MaaCore process bridge

Pinned upstream: [MAA v6.19.0-beta.2](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/v6.19.0-beta.2), Windows x64. The contract and archive digest live in `games/arknights/engine-contract.json`; a version bump does not certify task effects.
ABI: include/AsstCaller.h and include/AsstPort.h at that tag. All returns declared AsstBool are uint8, IDs int32, calls/callbacks stdcall, strings UTF-8. The callback delegate is rooted through native destruction.

`node scripts/setup-maacore.mjs` verifies the fixed release archive SHA-256 before extracting to ignored artifacts/vendor. Core and resource come from the same archive. `node scripts/build-bridge.mjs` publishes a self-contained .NET 8 process using SDK 8.0.400 and copies the verified runtime to dist/resources/maa-v6.19.0-beta.2. The documented startup patch applies only to the built copy. No game or emulator is launched by setup, build or init/probe.

JSON lines on stdin/stdout: requests `{id,method,...}`; responses `{id,ok,result?,error?}`; callbacks `{event:"callback",message,details}`. Methods: init(coreDir,logDir), connect(adbPath,address), runTask(type,params), stop, close. Only one native task is active. Task-chain errors remain failures after AllTasksCompleted. Stop waits native running=false and active request completion. EOF stops/destroys the instance. A hung native call is bounded by client timeout and process termination; ordinary cancellation awaits stop acknowledgement.

MuMu connections carry `mumu:{path,index,clientType}` derived from the exact ADB installation and instance address. After resource load and before connect, the bridge sets `AsstSetConnectionExtras("MuMuEmulator12", {path,index,client_type,touch:true})`, ClientType option 6 and TouchMode option 2 (`MumuExtras`). Other transports retain General. A rejected option fails the connection; the client is never silently changed to another channel or instance. Initialization/connection alone does not establish account identity or task completion.

Validation: `GamePilot.MaaBridge.exe --self-test` checks native callback outcome ordering without loading native code. `npx vitest run tests/maacore*.test.ts` tests process failure and cancellation acknowledgement. Actual DLL/resource probe and device execution are separate evidence; no fake callback is evidence of game completion.

MAA is AGPL-3.0. Keep upstream archive licenses/notices and corresponding source attribution when redistributing. Separate-process integration is not an automatic licensing exemption. The self-contained .NET publish includes Microsoft license and third-party notices. No game account credentials are accepted by this protocol.
