# GamePilot MaaCore process bridge

Pinned upstream: [MAA v6.17.5](https://github.com/MaaAssistantArknights/MaaAssistantArknights/tree/v6.17.5), Windows x64.
ABI: include/AsstCaller.h and include/AsstPort.h at that tag. All returns declared AsstBool are uint8, IDs int32, calls/callbacks stdcall, strings UTF-8. The callback delegate is rooted through native destruction.

`node scripts/setup-maacore.mjs` verifies the release archive SHA-256 from the official release asset digest before extracting to ignored artifacts/vendor. Core and resource come from the same archive. `node scripts/build-bridge.mjs` publishes a self-contained .NET 8 process and copies the verified runtime to dist/resources/maa-v6.17.5. No game or emulator is launched by setup, build or init/probe.

JSON lines on stdin/stdout: requests `{id,method,...}`; responses `{id,ok,result?,error?}`; callbacks `{event:"callback",message,details}`. Methods: init(coreDir,logDir), connect(adbPath,address), runTask(type,params), stop, close. Only one native task is active. Task-chain errors remain failures after AllTasksCompleted. Stop waits native running=false and active request completion. EOF stops/destroys the instance. A hung native call is bounded by client timeout and process termination; ordinary cancellation awaits stop acknowledgement.

Validation: `GamePilot.MaaBridge.exe --self-test` checks native callback outcome ordering without loading native code. `npx vitest run tests/maacore*.test.ts` tests process failure and cancellation acknowledgement. Actual DLL/resource probe and device execution are separate evidence; no fake callback is evidence of game completion.

MAA is AGPL-3.0. Keep upstream archive licenses/notices and corresponding source attribution when redistributing. Separate-process integration is not an automatic licensing exemption. The self-contained .NET publish includes Microsoft license and third-party notices. No game account credentials are accepted by this protocol.
