import { expect, it } from "vitest";
import { defaultDeviceLanes } from "../packages/protocol";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { freezeArknightsJob } from "../apps/desktop/main/arknights-job-snapshot";
import type { ArknightsJob } from "../packages/protocol/arknights-automation";

const lane = () => ({...defaultDeviceLanes({managerPath:"D:/MuMu/MuMuManager.exe",instance:0,closeEmulatorAfterSuccess:false}).lanes[0],enabled:true});
const job: ArknightsJob = {id:"am",name:"早班",laneId:"lane-a",enabled:true,time:"08:00",weekdays:[0],skillIds:["recruit","award"],catchUp:true};
it("freezes only the saved job's steps and retains account parameters, with mandatory login", () => {
  const input=lane(); input.arknights.enabled=true; input.onmyoji.enabled=true;
  const before=structuredClone(input), profiles=structuredClone(defaultArknightsProfiles);
  const frozen=freezeArknightsJob(input,profiles,{...job,laneId:input.id},new Date("2026-10-25T00:00:00Z"));
  expect(frozen.arknightsPlan?.skillIds).toEqual(["login","recruit","award"]);
  expect(frozen.onmyojiPlan).toBeUndefined();
  expect(frozen.profile?.id).toBe(input.arknights.profileId);
  profiles.profiles[0].stage="1-7";
  expect(frozen.profile?.stage).not.toBe("1-7");
  expect(input).toEqual(before);
});
it("rejects missing, disabled, or other-game channels rather than enabling them",()=>{
  const input=lane(); input.arknights.enabled=true;
  expect(()=>freezeArknightsJob(input,defaultArknightsProfiles,{...job,laneId:"wrong"})).toThrow();
  input.enabled=false;
  expect(()=>freezeArknightsJob(input,defaultArknightsProfiles,{...job,laneId:input.id})).toThrow();
  input.enabled=true; input.arknights.enabled=false;
  expect(()=>freezeArknightsJob(input,defaultArknightsProfiles,{...job,laneId:input.id})).toThrow();
});
