import { AtomicJsonStore } from "./atomic-json-store";
import contract from "../../../games/arknights/engine-contract.json";
import type { ArknightsClientType } from "../../../packages/runtime/activity-stage";
import type { StageResolverPort } from "./activity-stage-sync";
import type { ArknightsActivityCatalog } from "../../../packages/protocol/arknights-activity";
import { dirname, join } from "node:path";
import {
  boundedOfficialJson,
  currentActivityNavigation,
  officialActivitySource,
  readActivityNavigation,
  syncActivityNavigation,
  validActivityCatalogCache,
  type ActivityCatalogCache,
  type ActivityNavigation,
} from "../../../packages/runtime/maa-activity-resource";
import {
  currentOfficialActivityStage,
  officialActivityStages,
  officialActivityMiniGames,
} from "../../../games/arknights/activity-catalog";
export {
  currentOfficialActivityStage,
  officialActivityStages,
  officialActivityMiniGames,
} from "../../../games/arknights/activity-catalog";

interface Ports {
  now?: () => number;
  version?: string;
  readCache?: () => Promise<unknown>;
  writeCache?: (value: unknown) => Promise<void>;
  fetchData?: () => Promise<unknown>;
  /** These ports return the already hash-verified native overlay, never a boolean readiness hint. */
  readNavigation?: () => Promise<ActivityNavigation | undefined>;
  syncNavigation?: () => Promise<ActivityNavigation | undefined>;
}
interface PairedCache {
  cache: ActivityCatalogCache;
  navigation: ActivityNavigation;
  stale: boolean;
}
export class InternalActivityStageResolver implements StageResolverPort {
  private cached?: ActivityCatalogCache;
  private inFlight?: Promise<PairedCache | undefined>;
  private refreshing = false;
  private readonly now: () => number;
  private readonly readCache: () => Promise<unknown>;
  private readonly writeCache: (value: unknown) => Promise<void>;
  private readonly fetchData: () => Promise<unknown>;
  private readonly engineVersion: string;
  private readonly readNavigation: () => Promise<
    ActivityNavigation | undefined
  >;
  private readonly syncNavigation: () => Promise<
    ActivityNavigation | undefined
  >;

  constructor(file: string, ports: Ports = {}) {
    const store = new AtomicJsonStore<ActivityCatalogCache>(file);
    const root = join(dirname(file), "maa-activity");
    this.now = ports.now ?? Date.now;
    this.engineVersion = ports.version ?? contract.version;
    this.readCache = ports.readCache ?? (() => store.load());
    this.writeCache =
      ports.writeCache ??
      ((value) => store.save(value as ActivityCatalogCache));
    this.fetchData =
      ports.fetchData ??
      (async () => (await boundedOfficialJson(officialActivitySource)).data);
    this.readNavigation =
      ports.readNavigation ?? (() => readActivityNavigation(root, this.now()));
    this.syncNavigation =
      ports.syncNavigation ??
      (() =>
        syncActivityNavigation(root, { now: this.now, allowCached: false }));
  }
  private pair(
    cache: unknown,
    navigation: ActivityNavigation | undefined,
    stale: boolean,
  ): PairedCache | undefined {
    const valid = validActivityCatalogCache(
      cache,
      this.now(),
      this.engineVersion,
    );
    return valid &&
      currentActivityNavigation(navigation, this.now(), this.engineVersion) &&
      valid.navigationSha256 === navigation.sha256
      ? { cache: valid, navigation, stale }
      : undefined;
  }
  private async loadPair(refresh: boolean): Promise<PairedCache | undefined> {
    const previous =
      validActivityCatalogCache(this.cached, this.now(), this.engineVersion) ??
      validActivityCatalogCache(
        await this.readCache().catch(() => undefined),
        this.now(),
        this.engineVersion,
      );
    const navigation = await this.readNavigation().catch(() => undefined);
    const paired = this.pair(previous, navigation, false);
    if (!refresh && paired && this.now() - paired.cache.fetchedAt < 600000)
      return paired;
    try {
      // Wait for both operations even after one fails: a late navigation replacement
      // cannot invalidate a cache that we have already returned as a fallback.
      const [data, synced] = await Promise.allSettled([
        this.fetchData(),
        this.syncNavigation(),
      ]);
      if (
        data.status !== "fulfilled" ||
        synced.status !== "fulfilled" ||
        !currentActivityNavigation(synced.value, this.now(), this.engineVersion)
      )
        throw Error("官方活动数据与导航未同时同步");
      const next = validActivityCatalogCache(
        {
          version: 1,
          source: officialActivitySource,
          engineVersion: this.engineVersion,
          fetchedAt: this.now(),
          navigationSha256: synced.value.sha256,
          data: data.value,
        },
        this.now(),
        this.engineVersion,
      );
      if (!next) throw Error("官方活动目录格式无效");
      await this.writeCache(next);
      const verified = this.pair(next, await this.readNavigation(), false);
      if (!verified) throw Error("活动导航在同步后发生变化");
      return verified;
    } catch {
      return this.pair(
        previous,
        await this.readNavigation().catch(() => undefined),
        true,
      );
    }
  }
  private load(refresh = false): Promise<PairedCache | undefined> {
    if (this.inFlight) {
      return refresh && !this.refreshing
        ? this.inFlight.then(() => this.load(true))
        : this.inFlight;
    }
    this.refreshing = refresh;
    const pending = this.loadPair(refresh).then((value) => {
      this.cached = value?.cache;
      return value;
    });
    this.inFlight = pending;
    void pending
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async catalog(
    client: ArknightsClientType,
    refresh = false,
  ): Promise<ArknightsActivityCatalog> {
    const pair = await this.load(refresh),
      now = new Date(this.now());
    const routes = new Set(pair?.navigation.routes ?? []);
    const stages = pair
      ? officialActivityStages(
          pair.cache.data,
          client,
          now,
          this.engineVersion,
          routes,
        )
      : [];
    const miniGames = pair
      ? officialActivityMiniGames(
          pair.cache.data,
          client,
          now,
          this.engineVersion,
          routes,
        )
      : [];
    const stale =
      !pair || pair.stale || this.now() - pair.cache.fetchedAt >= 600000;
    return {
      source: officialActivitySource,
      ...(pair
        ? { fetchedAt: new Date(pair.cache.fetchedAt).toISOString() }
        : {}),
      stale,
      stages,
      miniGames,
      message: !pair
        ? "活动数据或导航暂不可用，保留已保存的关卡"
        : stages.some((stage) => stage.available)
          ? stale
            ? "使用已校验的本地活动缓存"
            : "已同步 MAA 官方活动关卡"
          : "当前没有开放、兼容且导航就绪的活动关卡，使用常驻关卡",
    };
  }
  async resolve(client: ArknightsClientType) {
    const pair = await this.load();
    return pair
      ? currentOfficialActivityStage(
          pair.cache.data,
          client,
          new Date(this.now()),
          this.engineVersion,
          new Set(pair.navigation.routes),
        )
      : null;
  }
}
