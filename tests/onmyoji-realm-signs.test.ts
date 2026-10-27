import { describe, expect, it } from "vitest";
import {
  isRealmSignsPage,
  ownTrainingEntry,
} from "../games/onmyoji/policy";
import type { Frame } from "../packages/runtime/device";
import fixture from "./fixtures/onmyoji/realm-signs-laneb-20261015.json";

/**
 * 2026-10-15 lane-b（账号二）实测：结界页的三块入口是会随场景摆动的悬挂木牌，
 * 竖排美术字 OCR 时好时坏——左牌「结界防守」被读成「结界陵守」（防→陵，0.798），
 * 中牌「式神育成」整块读不出。旧判据只认「防守」+ 中点靠左右牌推算，
 * 于是整块育成入口找到不、寄养第一步就失败（lane-a 同一页面读得到，所以只有账号二出问题）。
 *
 * 夹具是当时那张真实帧的 OCR 命中（见 tests/fixtures/onmyoji/ 的溯源说明）。
 */
const realm = fixture as unknown as Frame;
const courtyard = (): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    { text: "加成", box: [552, 49, 34, 66], score: 0.999 },
    { text: "探索", box: [988, 200, 46, 103], score: 0.998 },
  ],
});

describe("结界页三块木牌", () => {
  it("容忍已观测到的 OCR 变体（结界陵守），认出这是结界页", () => {
    expect(isRealmSignsPage(realm)).toBe(true);
  });

  it("用左右两块牌子推算出中间的式神育成入口", () => {
    const entry = ownTrainingEntry(realm);
    expect(entry).not.toBeNull();
    // 左牌中心 ≈515，右牌中心 ≈1329 → 中点 ≈922；两块牌子同一行（y≈655）。
    expect(entry![0]).toBeCloseTo(922, 0);
    expect(entry![1]).toBeCloseTo(656, 0);
  });

  it("庭院上不误判", () => {
    expect(isRealmSignsPage(courtyard())).toBe(false);
    expect(ownTrainingEntry(courtyard())).toBeNull();
  });

  it("只有一块牌子时不猜（避免点到别的入口）", () => {
    const oneSign: Frame = {
      ...realm,
      texts: realm.texts?.filter((hit) => hit.text !== "结界陵守"),
    };
    expect(isRealmSignsPage(oneSign)).toBe(false);
    expect(ownTrainingEntry(oneSign)).toBeNull();
  });
});
