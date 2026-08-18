import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { parseQuery, setMatches, simpleMatch } from "./search";
import type { Beatmap, BeatmapSetLike } from "./search";
import "./styles.css";

interface RealmFile {
  filename: string;
  hash: string;
  size: number;
}

interface BeatmapSet extends BeatmapSetLike {
  id: string;
  cover_hash: string | null;
  files: RealmFile[];
}

interface Skin {
  id: string;
  name: string;
  creator: string;
  files: RealmFile[];
}

interface Score {
  id: string;
  replay_hash: string;
  replay_size: number;
  beatmap: string;
  difficulty: string;
  rank: number;
  total_score: number;
  accuracy: number;
  max_combo: number;
  date: string;
  mods: string;
  ruleset: string;
  set_id: string;
  beatmap_romanized: string;
}

interface Collection {
  name: string;
  set_ids: string[];
}

interface Library {
  sets: BeatmapSet[];
  skins: Skin[];
  scores: Score[];
  collections: Collection[];
}

type Tab = "beatmaps" | "skins" | "replays";

interface LazerStatus {
  dataRoot: string | null;
  filesRoot: string | null;
  realmPath: string | null;
  autoDataRoot: string | null;
  usingCustom: boolean;
}

const RANKS = ["", "SS", "S", "A", "B", "C", "D"];

const els = {
  status: document.getElementById("lazer-status")!,
  changeDir: document.getElementById("change-dir")!,
  pageNav: document.getElementById("page-nav")!,
  pageExport: document.getElementById("page-export")!,
  pageSpace: document.getElementById("page-space")!,
  pageCollections: document.getElementById("page-collections")!,
  collectionLoad: document.getElementById("collection-load")!,
  collectionSummary: document.getElementById("collection-summary")!,
  lazerCollectionList: document.getElementById("lazer-collection-list")!,
  stableCollectionList: document.getElementById("stable-collection-list")!,
  collectionSync: document.getElementById("collection-sync")!,
  collectionDelete: document.getElementById("collection-delete")!,
  collectionExportCopy: document.getElementById("collection-export-copy")!,
  collectionResult: document.getElementById("collection-result")!,
  diskUsageBtn: document.getElementById("disk-usage-btn")!,
  usageContent: document.getElementById("usage-content")!,
  selectAllCollections: document.getElementById("select-all-collections")!,
  stablePath: document.getElementById("stable-dir-display")!,
  lazerPath: document.getElementById("lazer-dir-display")!,
  lazerBrowse: document.getElementById("lazer-browse")!,
  lazerAuto: document.getElementById("lazer-auto")!,
  spaceStableDir: document.getElementById("space-stable-dir")!,
  collectionsStableDir: document.getElementById("collections-stable-dir")!,
  stableBrowse: document.getElementById("stable-browse")!,
  stableAuto: document.getElementById("stable-auto")!,
  dedupeRun: document.getElementById("dedupe-run") as HTMLButtonElement,
  dedupeExecute: document.getElementById("dedupe-execute") as HTMLButtonElement,
  dedupeProgress: document.getElementById("dedupe-progress")!,
  dedupeProgressText: document.getElementById("dedupe-progress-text")!,
  dedupeProgressFill: document.getElementById("dedupe-progress-fill")!,
  dedupeStop: document.getElementById("dedupe-stop")!,
  dedupeResult: document.getElementById("dedupe-result")!,
  resetDir: document.getElementById("reset-dir")!,
  navSearch: document.getElementById("nav-search") as HTMLInputElement,
  unicodeMode: document.getElementById("unicode-mode") as HTMLInputElement,
  perfMode: document.getElementById("perf-mode") as HTMLInputElement,
  pageSettings: document.getElementById("page-settings")!,
  invertSelect: document.getElementById("invert-select")!,
  collectionChips: document.getElementById("collection-chips")!,
  sortKey: document.getElementById("sort-key") as HTMLSelectElement,
  sortDir: document.getElementById("sort-dir") as HTMLButtonElement,
  rulesetFilter: document.getElementById("ruleset-filter")!,
  collectionNav: document.getElementById("collection-nav")!,
  search: document.getElementById("search") as HTMLInputElement,
  sidebar: document.getElementById("sidebar")!,
  list: document.getElementById("list")!,
  selectAll: document.getElementById("select-all")!,
  selectNone: document.getElementById("select-none")!,
  selectionInfo: document.getElementById("selection-info")!,
  reload: document.getElementById("reload")!,
  exportBtn: document.getElementById("export") as HTMLButtonElement,
  exportModal: document.getElementById("export-modal")!,
  exportClose: document.getElementById("export-close")!,
  exportSummary: document.getElementById("export-summary")!,
  exportPath: document.getElementById("export-path") as HTMLInputElement,
  exportFormatRow: document.getElementById("export-format-row")!,
  hardlinkRow: document.getElementById("hardlink-row")!,
  hardlinkMode: document.getElementById("hardlink-mode") as HTMLInputElement,
  overwriteMode: document.getElementById("overwrite-mode") as HTMLInputElement,
  exportSelectedSets: document.getElementById("export-selected-sets")!,
  exportBrowse: document.getElementById("export-browse")!,
  exportCancel: document.getElementById("export-cancel")!,
  exportConfirm: document.getElementById("export-confirm") as HTMLButtonElement,
  progressWrap: document.getElementById("exporting-modal")!,
  exportingClose: document.getElementById("exporting-close")!,
  stopExport: document.getElementById("stop-export")!,
  progressText: document.getElementById("progress-text")!,
  progressFill: document.getElementById("progress-fill")!,
};

let library: Library | null = null;
const sizeById = new Map<string, number>();
// files/ 内容寻址根（detect_lazer 返回），封面经 convertFileSrc 直接读取 blob。
let filesRoot: string | null = null;
// 谱面集 id → 封面 hash，回放列表用。
const coverBySetId = new Map<string, string>();
// 当前收藏夹内的加入顺序（id → 序号），供“按收藏顺序排序”。
const collectionOrderById = new Map<string, number>();
let tab: Tab = "beatmaps";
// 当前主页面：export（导出列表）/ space（空间管理）/ collections（收藏夹管理）。
let page: "export" | "space" | "collections" | "settings" = "export";
// 仅显示重复导入的谱面集。

function switchPage(next: "export" | "space" | "collections" | "settings") {
  page = next;
  els.pageExport.hidden = next !== "export";
  els.pageSpace.hidden = next !== "space";
  els.pageCollections.hidden = next !== "collections";
  els.pageSettings.hidden = next !== "settings";
  els.pageNav
    .querySelectorAll(".chip")
    .forEach((chip) => chip.classList.toggle("active", (chip as HTMLElement).dataset.page === next));
  // 侧栏的收藏夹导航只在导出页显示。
  els.sidebar.style.display = next === "export" ? "" : "none";
}
// beatmaps 子分类筛选：null = 全部，"__none__" = 未加入任何收藏夹，
// Set = 多选的收藏夹名集合（列表显示其并集）。
let collectionFilter: "__none__" | Set<string> | null = null;
// 排序方式（key 见 SORT_OPTIONS，desc 为降序）。
let sortKey = "date_added";
let sortDesc = true;
// 模式筛选：空串 = 全部，否则为 ruleset 短名（osu/taiko/fruits/mania）。
let rulesetFilter = "";
// 是否优先显示 Unicode 名（标题/作者）；搜索始终同时匹配罗马字与 Unicode。
let unicodeMode = true;
// 无图模式（全局）：所有列表不加载封面，滚动渲染只保留文本。
let perfMode = false;

/** 从 localStorage 恢复设置。 */
function restoreSettings() {
  try {
    unicodeMode = localStorage.getItem("setting-unicode") !== "0";
    perfMode = localStorage.getItem("setting-perf") === "1";
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  els.unicodeMode.checked = unicodeMode;
  els.perfMode.checked = perfMode;
}

function persistSetting(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* 忽略持久化失败 */
  }
}
let exporting = false;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** 把当前 stable 目录同步显示到相关页面与设置页。 */
function updateStableDirDisplays() {
  const path = els.stablePath.textContent.trim();
  els.stablePath.textContent = path || "未设置";
  els.spaceStableDir.textContent = path ? `当前 stable 目录：${path}` : "未设置 stable 目录（在设置页选择）";
  els.collectionsStableDir.textContent = els.spaceStableDir.textContent;
}

function setStatus(text: string, ok: boolean | null = null) {
  els.status.textContent = text;
  els.status.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
}

/** 所有非顶栏提示统一用 toast：右上角浮层，几秒后自动消失。 */
function toast(text: string, ok: boolean | null = null) {
  const host = document.getElementById("toast-host")!;
  const el = document.createElement("div");
  el.className = "toast" + (ok === true ? " ok" : ok === false ? " err" : "");
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("fade");
    setTimeout(() => el.remove(), 400);
  }, 3500);
}

/** 按 Unicode 开关取显示名：开 = Unicode 优先，关 = 罗马字优先。 */
function pickName(unicode: string, romanized: string): string {
  const first = unicodeMode ? unicode : romanized;
  return first || (unicodeMode ? romanized : unicode) || "";
}

function setTotalSize(set: BeatmapSet): number {
  return set.files.reduce((sum, f) => sum + f.size, 0);
}

// ---- 星级颜色：移植自 lazer 的 OsuColour.STAR_DIFFICULTY_SPECTRUM ----

const STAR_DIFFICULTY_SPECTRUM: [number, [number, number, number]][] = [
  [0.1, [0xaa, 0xaa, 0xaa]],
  [0.1, [0x42, 0x90, 0xfb]],
  [1.25, [0x4f, 0xc0, 0xff]],
  [2.0, [0x4f, 0xff, 0xd5]],
  [2.5, [0x7c, 0xff, 0x4f]],
  [3.3, [0xf6, 0xf0, 0x5c]],
  [4.2, [0xff, 0x80, 0x68]],
  [4.9, [0xff, 0x4e, 0x6f]],
  [5.8, [0xc6, 0x45, 0xb8]],
  [6.7, [0x65, 0x63, 0xde]],
  [7.7, [0x18, 0x15, 0x8e]],
  [9.0, [0x00, 0x00, 0x00]],
  [10.0, [0x00, 0x00, 0x00]],
];

// ---- 谱面状态徽章：osu-web beatmapset-status（list-view 变体）----
// 颜色按 osu-web colors.less 的 HSL 变量换算（base hue 333）。

const STATUS_BADGES: Record<number, [string, string, string]> = {
  // status → [显示名, 背景色, 文字色]
  1: ["ranked", "#b3e680", "#46393f"], // lime-1 / b3
  2: ["approved", "#b3e680", "#46393f"], // lime-1 / b3
  3: ["qualified", "#80c4e6", "#46393f"], // blue-1 / b3
  4: ["loved", "#e680ad", "#46393f"], // pink-1 / b3
  0: ["pending", "#e5cc80", "#46393f"], // orange-1 / b3
  [-1]: ["wip", "#e5a280", "#46393f"], // darkorange-1 / b3
  [-2]: ["graveyard", "#000000", "#705c65"], // 黑底 / b1
};

function statusBadge(status: number): string {
  const badge = STATUS_BADGES[status];
  if (!badge) return "";
  const [label, bg, colour] = badge;
  return `<span class="beatmapset-status beatmapset-status--list-view" style="background-color: ${bg}; color: ${colour}">${label}</span>`;
}

/** 星形图标（Font Awesome fa-star 同款路径）。 */
const STAR_ICON =
  '<svg viewBox="0 0 576 512" aria-hidden="true"><path fill="currentColor" d="M259.3 17.8L194 150.2 47.9 171.5c-26.2 3.8-36.7 36.1-17.7 54.6l105.7 103-25 145.5c-4.5 26.3 23.2 46 46.4 33.7L288 439.6l130.7 68.7c23.2 12.2 50.9-7.4 46.4-33.7l-25-145.5 105.7-103c19-18.5 8.5-50.8-17.7-54.6L338 150.2 292.9 17.8c-11.7-26.2-44.6-26.2-56.3 0z"/></svg>';

function starBadge(star: number): string {
  return (
    `<span class="difficulty-badge difficulty-badge--beatmapset" style="--bg: ${starColour(star)}; color: ${starTextColour(star)}">` +
    `<span class="difficulty-badge__icon">${STAR_ICON}</span>` +
    `<span class="difficulty-badge__rating">${star.toFixed(2)}</span>` +
    `</span>`
  );
}

/** lazer 的 ColourUtils.SampleFromLinearGradient 同款采样。 */
/** 通用线性渐变采样（lazer ColourUtils.SampleFromLinearGradient）。 */
function sampleGradient(
  spectrum: [number, [number, number, number]][],
  value: number,
): string {
  if (value <= spectrum[0][0]) {
    return rgbHex(spectrum[0][1]);
  }
  for (let i = 1; i < spectrum.length; i++) {
    const [pos, colour] = spectrum[i];
    if (value <= pos) {
      const [prevPos, prevColour] = spectrum[i - 1];
      const t = pos === prevPos ? 0 : (value - prevPos) / (pos - prevPos);
      const mixed = prevColour.map((c, index) =>
        Math.round(c + (colour[index] - c) * t),
      ) as [number, number, number];
      return rgbHex(mixed);
    }
  }
  const last = spectrum[spectrum.length - 1];
  return rgbHex(last[1]);
}

function starColour(star: number): string {
  return sampleGradient(STAR_DIFFICULTY_SPECTRUM, Math.round(star * 100) / 100);
}

// lazer OsuColour.ForStarDifficultyText 同款：星级徽章文字色。
const STAR_DIFFICULTY_TEXT_SPECTRUM: [number, [number, number, number]][] = [
  [9.0, [0xf6, 0xf0, 0x5c]],
  [9.9, [0xff, 0x80, 0x68]],
  [10.6, [0xff, 0x4e, 0x6f]],
  [11.5, [0xc6, 0x45, 0xb8]],
  [12.4, [0x65, 0x63, 0xde]],
];

function starTextColour(star: number): string {
  const value = Math.round(star * 100) / 100;
  // < 6.5：黑色 75% 不透明度；6.5–9.0：Orange1；≥ 9.0：文字色谱采样。
  if (value < 6.5) return "rgba(0, 0, 0, 0.75)";
  if (value < 9.0) return "rgb(255, 217, 102)";
  return sampleGradient(STAR_DIFFICULTY_TEXT_SPECTRUM, value);
}

function rgbHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---- 搜索（普通子串 / 正则）与排序 ----

/** 每个分类支持的排序项：value → [标签, 取值函数（大→小）]。 */
const SORT_OPTIONS: Record<Tab, Record<string, [string, (item: never) => string | number]>> = {
  beatmaps: {
    date_added: ["导入日期", (s) => (s as unknown as BeatmapSet).date_added],
    title: ["标题", (s) => pickName((s as unknown as BeatmapSet).title_unicode, (s as unknown as BeatmapSet).title)],
    artist: ["作者", (s) => pickName((s as unknown as BeatmapSet).artist_unicode, (s as unknown as BeatmapSet).artist)],
    creator: ["谱师", (s) => (s as unknown as BeatmapSet).creator],
    beatmap_count: ["难度数", (s) => (s as unknown as BeatmapSet).beatmaps.length],
    online_id: ["上架编号", (s) => (s as unknown as BeatmapSet).online_id],
    collection_order: [
      "收藏顺序",
      (s) => collectionOrderById.get((s as unknown as BeatmapSet).id) ?? Number.MAX_SAFE_INTEGER,
    ],
    size: ["大小", (s) => setTotalSize(s as unknown as BeatmapSet)],
  },
  skins: {
    name: ["名称", (k) => (k as unknown as Skin).name],
    creator: ["作者", (k) => (k as unknown as Skin).creator],
    file_count: ["文件数", (k) => (k as unknown as Skin).files.length],
    size: ["大小", (k) => (k as unknown as Skin).files.reduce((sum, f) => sum + f.size, 0)],
  },
  replays: {
    date: ["日期", (r) => (r as unknown as Score).date],
    total_score: ["分数", (r) => (r as unknown as Score).total_score],
    accuracy: ["准确率", (r) => (r as unknown as Score).accuracy],
    max_combo: ["最大连击", (r) => (r as unknown as Score).max_combo],
    beatmap: ["谱面", (r) => (r as unknown as Score).beatmap],
  },
};

/** 当前分类下可用的排序键。 */
function availableSortKeys(): string[] {
  return Object.keys(SORT_OPTIONS[tab]);
}

/** 刷新排序下拉框；切分类时若当前键不可用则回退到首项。 */
function refreshSortSelect() {
  const keys = availableSortKeys();
  if (!keys.includes(sortKey)) {
    sortKey = keys[0];
  }
  els.sortKey.innerHTML = "";
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `按${SORT_OPTIONS[tab][key][0]}排序`;
    els.sortKey.appendChild(option);
  }
  els.sortKey.value = sortKey;
  els.sortDir.textContent = sortDesc ? "↓" : "↑";
}

/** 简单多词子串匹配（皮肤/回放分类）。 */
function makeMatcher(): (texts: string[]) => boolean {
  const query = els.search.value;
  return (texts) => simpleMatch(texts, query);
}

/** 按当前排序设置排序（原地稳定排序，字符串比较对中文友好）。 */
function sortCurrent<T>(items: T[], valueOf: (item: T) => string | number): T[] {
  const factor = sortDesc ? -1 : 1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const va = valueOf(a.item);
      const vb = valueOf(b.item);
      let compared: number;
      if (typeof va === "number" && typeof vb === "number") {
        compared = va - vb;
      } else {
        compared = String(va).localeCompare(String(vb), "zh-Hans-CN");
      }
      return compared * factor || a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---- 列表渲染 ----

function visibleItems<T>(
  items: T[],
  searchText: (item: T) => string,
  size: (item: T) => number,
  sub: (item: T) => string,
  title: (item: T) => string,
  // 传了 coverHash 才渲染封面区（含无封面时的灰占位）；不传则整行不预留位置。
  coverHash?: (item: T) => string | null,
): number {
  const visible = items;
  sizeById.clear();
  const frag = document.createDocumentFragment();
  for (const item of visible) {
    const id = (item as { id: string }).id;
    sizeById.set(id, size(item));
    // 行不用 <label>：label 会向 checkbox 转发合成 click，WebKit 下对转发事件
    // preventDefault 无法阻止默认翻转，shift 范围选择会状态错乱。点击行为在
    // 列表级的 click 委托里统一处理。
    const row = document.createElement("div");
    row.className = "row";
    const hash = !perfMode && coverHash ? coverHash(item) : undefined;
    const cover =
      hash === undefined
        ? ""
        : hash
          ? `<img class="cover" data-src="${coverUrl(hash)}" data-hash="${hash}" alt="" />`
          : `<div class="cover placeholder"></div>`;
    row.innerHTML = `
      <input type="checkbox" data-id="${id}" checked />
      ${cover}
      <div class="meta">
        <div class="title">${title(item)}</div>
        <div class="sub">${sub(item)}</div>
      </div>`;
    frag.appendChild(row);
  }
  els.list.innerHTML = "";
  els.list.appendChild(frag);
  lastCheckedId = null;
  if (!perfMode) observeCovers();
  return visible.length;
}

/** 封面 blob 经 asset 协议的访问地址：files/x/xy/<sha256>。 */
function coverUrl(hash: string): string {
  const root = filesRoot ?? "";
  const lower = hash.toLowerCase();
  return convertFileSrc(`${root}/files/${lower[0]}/${lower.slice(0, 2)}/${hash}`);
}

/** 懒加载：封面进入可视区后才设置 src（IntersectionObserver）。 */
let coverObserver: IntersectionObserver | null = null;
function observeCoversIn(container: HTMLElement) {
  ensureCoverObserver();
  container.querySelectorAll("img.cover[data-src]").forEach((img) => {
    coverObserver!.observe(img);
  });
}

function ensureCoverObserver() {
  if (coverObserver) return;
  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target as HTMLImageElement;
        const src = img.dataset.src;
        if (src) {
          img.src = src;
          delete img.dataset.src;
        }
        coverObserver?.unobserve(img);
      }
    },
    { rootMargin: "200px" },
  );
}

function observeCovers() {
  ensureCoverObserver();
  els.list.querySelectorAll("img.cover[data-src]").forEach((img) => {
    coverObserver!.observe(img);
  });
}

// asset 协议加载失败时的兜底：走 IPC 读 blob 转 data URL（error 不冒泡，需捕获）。
// 挂在 document 上可同时覆盖导出列表与收藏夹管理页的封面。
document.addEventListener(
  "error",
  (event) => {
    const img = event.target as HTMLImageElement;
    if (!img.classList.contains("cover") || img.dataset.fallback) return;
    const hash = img.dataset.hash;
    if (!hash) return;
    img.dataset.fallback = "1";
    invoke<string | null>("read_cover", { hash })
      .then((dataUrl) => {
        if (dataUrl) img.src = dataUrl;
        else img.classList.add("failed");
      })
      .catch(() => img.classList.add("failed"));
  },
  true,
);

/** 当前生效的收藏夹筛选以胶囊形式展示在列表上方，点 ✕ 逐个移除。 */
function renderCollectionChips() {
  const container = els.collectionChips;
  container.innerHTML = "";
  const names =
    collectionFilter instanceof Set
      ? [...collectionFilter]
      : collectionFilter === "__none__"
        ? ["__none__"]
        : [];
  if (tab !== "beatmaps" || names.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const name of names) {
    const chip = document.createElement("button");
    chip.className = "chip active";
    chip.title = "点击移除该筛选";
    chip.innerHTML = `${escapeHtml(
      name === "__none__" ? "未加入收藏夹" : name,
    )} <span class="chip-x">✕</span>`;
    chip.addEventListener("click", () => {
      if (collectionFilter instanceof Set) {
        const next = new Set(collectionFilter);
        next.delete(name);
        collectionFilter = next.size ? next : null;
      } else {
        collectionFilter = null;
      }
      renderSidebar();
      render();
    });
    container.appendChild(chip);
  }
}

function render() {
  if (!library) return;
  const matcher = makeMatcher();
  const sortValue = SORT_OPTIONS[tab][sortKey][1];
  els.rulesetFilter.hidden = tab === "skins";
  renderCollectionChips();
  if (tab === "beatmaps") {
    const criteria = parseQuery(els.search.value);
    // collectionFilter：null = 全部；"__none__" = 未收藏；Set = 选中的收藏夹并集。
    // 收藏顺序取各选中收藏夹内谱面集的加入顺序（realm 的 BeatmapMD5Hashes 顺序）。
    const filterSet = collectionFilter instanceof Set ? collectionFilter : null;
    const selectedCollections = filterSet
      ? library.collections.filter((c) => filterSet.has(c.name))
      : [];
    collectionOrderById.clear();
    for (const c of selectedCollections) {
      c.set_ids.forEach((id, index) => {
        if (!collectionOrderById.has(id)) collectionOrderById.set(id, index);
      });
    }
    // 过滤优先级：多选并集 > 未加入收藏夹 > 全部。
    const collection =
      filterSet
        ? library.sets.filter((s) =>
            selectedCollections.some((c) => c.set_ids.includes(s.id)),
          )
        : collectionFilter === "__none__"
          ? library.sets.filter(
              (s) => !library!.collections.some((c) => c.set_ids.includes(s.id)),
            )
          : library.sets;
    const items = sortCurrent(
      collection
        .filter((s) =>
          rulesetFilter === "" ? true : s.beatmaps.some((b) => b.ruleset === rulesetFilter),
        )
        .filter((s) => setMatches(s, criteria)),
      (s) => sortValue(s as never),
    );
    visibleItems(
      items,
      (s) => `${s.artist} ${s.artist_unicode} ${s.title} ${s.title_unicode} ${s.creator}`,
      setTotalSize,
      (s) => {
        const artist = pickName(s.artist_unicode, s.artist);
        const title = pickName(s.title_unicode, s.title);
        const parts = [
          `by ${escapeHtml(s.creator)}`,
          `${s.beatmaps.length} 难度`,
          fmtSize(setTotalSize(s)),
        ];
        if (s.online_id > 0) parts.push(`#${s.online_id}`);
        // 默认显示谱面集的难度范围：min ~ max，各自按星级配色渲染成两个徽章。
        const stars = s.beatmaps.map((b) => b.star_rating).filter((v) => v > 0);
        if (stars.length) {
          const min = Math.min(...stars);
          const max = Math.max(...stars);
          parts.push(
            max - min >= 0.01
              ? `${starBadge(min)}<span class="star-range-sep">~</span>${starBadge(max)}`
              : starBadge(max),
          );
        }
        return parts.join(" · ");
      },
      (s) => {
        const status = statusBadge(s.beatmaps[0]?.status ?? -3);
        const name = escapeHtml(
          `${pickName(s.artist_unicode, s.artist)} - ${pickName(s.title_unicode, s.title)}`,
        );
        return status ? `${status} ${name}` : name;
      },
      (s) => s.cover_hash,
    );
  } else if (tab === "skins") {
    const items = sortCurrent(
      library.skins.filter((k) => matcher([k.name, k.creator])),
      (k) => sortValue(k as never),
    );
    visibleItems(
      items,
      (k) => `${k.name} ${k.creator}`,
      (k) => k.files.reduce((sum, f) => sum + f.size, 0),
      (k) =>
        `by ${escapeHtml(k.creator || "未知")} · ${k.files.length} 个文件 · ${fmtSize(
          k.files.reduce((sum, f) => sum + f.size, 0),
        )}`,
      (k) => escapeHtml(k.name || "(未命名皮肤)"),
    );
  } else {
    const items = sortCurrent(
      library.scores.filter(
        (r) =>
          (rulesetFilter === "" || r.ruleset === rulesetFilter) &&
          matcher([r.beatmap, r.difficulty]),
      ),
      (r) => sortValue(r as never),
    );
    visibleItems(
      items,
      (r) => `${r.beatmap} ${r.difficulty}`,
      (r) => r.replay_size,
      (r) =>
        `${RANKS[r.rank] ?? "?"} · ${r.total_score.toLocaleString()} · ${fmtSize(r.replay_size)}${
          r.mods && r.mods !== "[]" ? ` · ${escapeHtml(r.mods)}` : ""
        }${r.date ? ` · ${r.date}` : ""}`,
      (r) =>
        escapeHtml(r.difficulty ? `${r.beatmap} [${r.difficulty}]` : r.beatmap),
      (r) => (r.set_id ? (coverBySetId.get(r.set_id) ?? null) : null),
    );
  }
  updateSelectionInfo();
}

function selectedIds(): string[] {
  return Array.from(els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
    .map((box) => box.dataset.id!)
    .filter(Boolean);
}

function updateSelectionInfo() {
  const boxes = els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const checked = Array.from(boxes).filter((b) => b.checked);
  const size = checked.reduce((sum, b) => sum + (sizeById.get(b.dataset.id!) || 0), 0);
  // 始终显示（含 0 项），避免选中数变化时工具栏布局跳动。
  els.selectionInfo.textContent = `已选 ${checked.length} 项（${fmtSize(size)}）`;
  els.exportBtn.disabled = checked.length === 0 || exporting;
}

function renderSidebar() {
  document.querySelectorAll("#sidebar .nav-item.category").forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle("active", el.dataset.tab === tab);
    el.querySelector(".arrow")!.textContent = "▾";
  });
  document
    .querySelectorAll("#sidebar .nav-item:not(.category):not(.sub)")
    .forEach((btn) => btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab));
  const nav = els.collectionNav;
  nav.innerHTML = "";
  const expanded = tab === "beatmaps";
  nav.style.display = expanded ? "flex" : "none";
  els.selectAllCollections.style.display = tab === "beatmaps" ? "" : "none";
  if (!library || !expanded) return;

  const lib = library;
  const query = els.navSearch.value.trim().toLowerCase();
  const uncollected = lib.sets.filter(
    (s) => !lib.collections.some((c) => c.set_ids.includes(s.id)),
  ).length;
  const matched = query
    ? lib.collections.filter((c) => c.name.toLowerCase().includes(query))
    : lib.collections;

  // 收藏夹支持多选（并集显示）；"全部谱面"和"未加入收藏夹"为互斥项，点击会清空多选。
  const entries: { label: string; value: string; count: number }[] = [
    { label: "全部谱面", value: "", count: lib.sets.length },
    ...matched.map((c) => ({ label: c.name, value: c.name, count: c.set_ids.length })),
    { label: "未加入收藏夹", value: "__none__", count: uncollected },
  ];
  for (const { label, value, count } of entries) {
    const isCollection = value !== "" && value !== "__none__";
    const selected = isCollection
      ? collectionFilter instanceof Set && collectionFilter.has(value)
      : collectionFilter === (value === "" ? null : value);
    // 收藏夹行拆成两个点击区：☐/☑ 框切换多选成员；名称单独打开该收藏夹。
    const item = document.createElement("div");
    item.className = "nav-item sub collection-item" + (selected ? " active" : "");

    const nameButton = document.createElement("button");
    nameButton.className = "collection-name";
    nameButton.textContent = `${label} (${count})`;
    nameButton.title = label;
    nameButton.addEventListener("click", () => {
      if (value === "") {
        collectionFilter = null;
      } else if (value === "__none__") {
        // 再点一次取消“未加入收藏夹”筛选。
        collectionFilter = collectionFilter === "__none__" ? null : "__none__";
      } else {
        // 点名称 = 单选该收藏夹（再点一次清空）；之后可用 ☐/☑ 增减成员。
        const current = collectionFilter instanceof Set ? collectionFilter : new Set<string>();
        collectionFilter =
          current.size === 1 && current.has(value) ? null : new Set([value]);
      }
      renderSidebar();
      render();
    });
    item.appendChild(nameButton);

    if (isCollection) {
      const inSet = collectionFilter instanceof Set && collectionFilter.has(value);
      const check = document.createElement("button");
      check.className = "collection-check";
      check.textContent = inSet ? "☑" : "☐";
      check.title = "加入/移出多选";
      check.addEventListener("click", (event) => {
        event.stopPropagation();
        const set =
          collectionFilter instanceof Set ? new Set(collectionFilter) : new Set<string>();
        if (set.has(value)) set.delete(value);
        else set.add(value);
        collectionFilter = set.size ? set : null;
        renderSidebar();
        render();
      });
      item.appendChild(check);
    }
    nav.appendChild(item);
  }
}

// ---- 数据加载与导出 ----

async function load() {
  try {
    const status = await invoke<LazerStatus>("detect_lazer");
    // 设置页显示实际文件存储目录：storage.ini 的 FullPath 存在时以它为准。
    els.lazerPath.textContent = status.filesRoot ?? status.dataRoot ?? "未检测到";
    els.resetDir.hidden = !status.usingCustom;
    filesRoot = status.filesRoot;
    if (!status.realmPath) {
      els.status.textContent = status.filesRoot ?? status.dataRoot ?? "未检测到";
      els.status.className = "status err";
      toast(
        status.usingCustom
          ? `所选目录中没有 client.realm，请重新选择。`
          : `未找到 osu!lazer 数据目录（期望 ${status.dataRoot ?? "?"}）。`,
        false,
      );
      return;
    }
    // 顶栏与其他所有显示统一：storage.ini 的 FullPath 存在时一律显示那个目录。
    const shownDir = status.filesRoot ?? status.dataRoot ?? "?";
    // 加载期间顶栏先显示目录，加载完成后再补全统计信息。
    setStatus(`目录：${shownDir}`);
    const result = await invoke<{ realmPath: string; library: Library }>("list_library");
    library = result.library;
    setStatus(
      `目录：${shownDir} · 谱面 ${library.sets.length} · 皮肤 ${library.skins.length} · 回放 ${library.scores.length}`,
      true,
    );
    coverBySetId.clear();
    for (const set of library.sets) {
      if (set.cover_hash) coverBySetId.set(set.id, set.cover_hash);
    }
    renderSidebar();
    render();
  } catch (error) {
    toast(`读取失败：${error}`, false);
  }
}

async function changeDir() {
  const dir = await open({ directory: true, title: "选择 osu!lazer 数据目录（需包含 client.realm）" });
  if (!dir) return;
  try {
    await invoke("set_lazer_data_dir", { path: dir });
  } catch (error) {
    toast(`设置目录失败：${error}`, false);
    return;
  }
  try {
    localStorage.setItem("lazer-dir", dir);
  } catch {
    /* 忽略持久化失败 */
  }
  library = null;
  els.list.innerHTML = "";
  await load();
}

async function resetDir() {
  try {
    await invoke("set_lazer_data_dir", { path: null });
  } catch (error) {
    toast(`恢复默认目录失败：${error}`, false);
    return;
  }
  try {
    localStorage.removeItem("lazer-dir");
  } catch {
    /* 忽略 */
  }
  library = null;
  els.list.innerHTML = "";
  await load();
}

// ---- 导出确认弹窗 ----

// 弹窗打开时暂存的待导出内容（点"开始导出"时使用）。
let pendingExport: { ids: string[]; label: string; md5s?: string[] } | null = null;

const TYPE_LABELS: Record<Tab, string> = {
  beatmaps: "谱面（.osz）",
  skins: "皮肤（.osk）",
  replays: "回放（.osr）",
};

/** 打开导出确认弹窗：显示导出内容统计，路径记忆上次选择。 */
function openExportModal(
  override?: { ids: string[]; label: string; md5s?: string[] },
  preferredDir?: string,
) {
  if (exporting || !library) return;
  const ids = override?.ids ?? selectedIds();
  if (!ids.length && !override) return;
  const label = override?.label ?? TYPE_LABELS[tab];
  const size = ids.reduce((sum, id) => sum + (sizeById.get(id) || 0), 0);
  pendingExport = override
    ? { ...override }
    : { ids, label };
  els.exportSummary.textContent = pendingExport.md5s
    ? `将按下方选项导出所选集合的谱面集（${new Set(pendingExport.md5s).size} 个，去重后）。`
    : `将导出 ${ids.length} 个${label}，共 ${fmtSize(size)}。`;
  let lastDir: string | null = null;
  try {
    lastDir = localStorage.getItem("export-dir");
  } catch {
    /* 忽略 */
  }
  els.exportPath.value = preferredDir?.trim() || lastDir || "";
  // 回放导出就是单个 .osr 文件，压缩包/文件夹选项不适用。
  els.exportFormatRow.hidden = tab === "replays";
  if (tab === "replays") {
    els.hardlinkRow.hidden = true;
  } else {
    const folder =
      document.querySelector<HTMLInputElement>('input[name="export-format"]:checked')?.value ===
      "folder";
    els.hardlinkRow.hidden = !folder;
  }
  updateExportConfirm();
  els.exportModal.hidden = false;
}

document.querySelectorAll<HTMLInputElement>('input[name="export-format"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const folder = document.querySelector<HTMLInputElement>(
      'input[name="export-format"]:checked',
    )?.value === "folder";
    els.hardlinkRow.hidden = !folder;
  });
});

/** 未选路径时禁用确认按钮。 */
function updateExportConfirm() {
  els.exportConfirm.disabled = !els.exportPath.value.trim();
}

function closeExportModal() {
  if (exporting) return;
  pendingExport = null;
  els.exportModal.hidden = true;
}

async function browseExportPath() {
  const dir = await open({ directory: true, title: "选择导出目录" });
  if (!dir) return;
  els.exportPath.value = dir;
  try {
    localStorage.setItem("export-dir", dir);
  } catch {
    /* 忽略持久化失败 */
  }
  updateExportConfirm();
}

async function exportSelected() {
  if (exporting || !library || !pendingExport) return;
  const { ids, label, md5s: exportMd5s } = pendingExport;
  const outDir = els.exportPath.value.trim();
  if (!outDir) return;

  const useMd5s = !!pendingExport?.md5s;
  const command = useMd5s
    ? "export_selected_sets"
    : tab === "beatmaps"
      ? "export_sets"
      : tab === "skins"
        ? "export_skins"
        : "export_replays";
  const argName = useMd5s
    ? "md5s"
    : tab === "beatmaps"
      ? "setIds"
      : tab === "skins"
        ? "skinIds"
        : "scoreIds";
  const format =
    document.querySelector<HTMLInputElement>('input[name="export-format"]:checked')?.value ??
    "archive";
  const args: Record<string, unknown> = {
    outDir,
    format,
    hardlink: format === "folder" && els.hardlinkMode.checked,
    // 导出文件名一律使用罗马字（Unicode 名仅用于界面显示）。
    useUnicode: false,
    // 强制覆盖：默认不勾选（跳过已存在文件）。
    overwrite: els.overwriteMode.checked,
  };
  args[argName] = useMd5s ? (exportMd5s ?? []) : ids;

  pendingExport = null;
  els.exportModal.hidden = true;
  exporting = true;
  cancelling = false;
  els.exportBtn.disabled = true;
  els.progressWrap.hidden = false;
  els.stopExport.hidden = false;
  setProgress(0, `准备导出 ${ids.length} 个${label}…`);

  try {
    const result = await invoke<{
      failures: string[];
      cancelled: boolean;
      completed: number;
      total: number;
      notices: string[];
      skipped: number;
    }>(command, args);
    const noticeText = result.notices.length
      ? `（提示：${result.notices.slice(0, 2).join("；")}${result.notices.length > 2 ? " 等" : ""}）`
      : "";
    const skipText = result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在文件` : "";
    if (result.cancelled) {
      setProgress(
        result.completed / Math.max(result.total, 1),
        `已终止导出：完成 ${result.completed}/${result.total}${
          result.failures.length ? `，失败 ${result.failures.length} 个` : ""
        }${skipText}。${noticeText}`,
      );
    } else if (result.failures.length) {
      setProgress(
        1,
        `导出完成，${result.failures.length} 个失败：${result.failures.slice(0, 3).join("；")}${
            result.failures.length > 3 ? " 等" : ""
          }`,
      );
    } else {
      setProgress(1, `导出完成，共 ${result.completed} 个 ${label} 文件${skipText}。${noticeText}`);
    }
  } catch (error) {
    setProgress(1, `导出失败：${error}`);
  } finally {
    exporting = false;
    cancelling = false;
    els.stopExport.hidden = true;
    els.exportBtn.disabled = selectedIds().length === 0;
  }
}

/** 导出窗口的关闭（✕ / 遮罩）：导出中需在 3 秒内点两次才终止，防误触。 */
let closeArmed = false;
let closeArmedTimer: ReturnType<typeof setTimeout> | undefined;
async function requestCloseExporting() {
  if (!exporting) {
    els.progressWrap.hidden = true;
    return;
  }
  if (cancelling) return;
  if (!closeArmed) {
    closeArmed = true;
    els.progressText.textContent = "导出尚未完成：再次点击关闭将终止导出（3 秒内有效）…";
    clearTimeout(closeArmedTimer);
    closeArmedTimer = setTimeout(() => (closeArmed = false), 3000);
    return;
  }
  closeArmed = false;
  clearTimeout(closeArmedTimer);
  await stopExport();
}

// 用户请求终止：置标志并提示，后端在当前条目写完后停止。
let cancelling = false;
async function stopExport() {
  if (!exporting || cancelling) return;
  cancelling = true;
  els.progressText.textContent = "正在终止导出…";
  try {
    await invoke("cancel_export");
  } catch {
    /* 后端不可达时忽略 */
  }
}

function setProgress(fraction: number, text: string) {
  els.progressText.textContent = text;
  els.progressFill.style.width = `${Math.round(fraction * 100)}%`;
}


// ---- 空间维护工具：磁盘占用统计 / 与 stable 去重压缩 ----

let usageRunning = false;

async function showDiskUsage() {
  if (usageRunning) return;
  usageRunning = true;
  els.diskUsageBtn.disabled = true;
  els.usageContent.textContent = "正在统计…";
  try {
    const usage = await invoke<{
      path: string;
      totalSize: number;
      uniqueSize: number;
      fileCount: number;
    }>("get_lazer_disk_usage");
    const shared = usage.totalSize - usage.uniqueSize;
    els.usageContent.innerHTML = `
      <div class="usage-row"><span>目录</span><span>${escapeHtml(usage.path)}</span></div>
      <div class="usage-row"><span>文件数</span><span>${usage.fileCount.toLocaleString()}</span></div>
      <div class="usage-row"><span>总大小</span><span>${fmtSize(usage.totalSize)}</span></div>
      <div class="usage-row"><span>实际占用（排除硬链接）</span><span>${fmtSize(usage.uniqueSize)}</span></div>
      <div class="usage-row"><span>已共享（硬链接）</span><span>${fmtSize(shared)}</span></div>
      <div class="setting-desc">从 stable 导入的文件以硬链接存在，删除 lazer 目录不会释放共享部分的空间。</div>`;
  } catch (error) {
    els.usageContent.textContent = `统计失败：${error}`;
  } finally {
    usageRunning = false;
    els.diskUsageBtn.disabled = false;
  }
}

const DEDUPE_PHASES: Record<string, string> = {
  "scan-lazer": "扫描 lazer 文件存储",
  "scan-stable": "扫描 stable 谱面目录",
  hash: "计算候选文件 SHA-256",
  link: "替换为硬链接",
};

let dedupeRunning = false;

async function runDedupe(dryRun: boolean) {
  if (dedupeRunning) return;
  const stableRoot = els.stablePath.textContent.trim();
  if (stableRoot === "未设置") return;
  if (!stableRoot) return;
  dedupeRunning = true;
  els.dedupeRun.disabled = true;
  els.dedupeExecute.disabled = true;
  els.dedupeProgress.hidden = false;
  els.dedupeStop.hidden = false;
  els.dedupeResult.textContent = "";
  els.dedupeProgressFill.classList.remove("indeterminate");
  els.dedupeProgressFill.style.width = "0%";
  els.dedupeProgressText.textContent = "准备扫描…";
  try {
    const result = await invoke<{
      dryRun: boolean;
      cancelled: boolean;
      lazerFilesRoot: string;
      candidateCount: number;
      reclaimableSize: number;
      linkedCount: number;
      linkedSize: number;
      skippedCrossVolumeCount: number;
      skippedCrossVolumeSize: number;
      failedCount: number;
      alreadyLinkedSize: number;
    }>("dedupe_lazer_files", {
      stableRoot,
      dryRun,
    });
    const lines: string[] = [];
    if (result.cancelled) lines.push("已终止。");
    lines.push(`lazer 文件存储：${result.lazerFilesRoot}`);
    if (result.dryRun) {
      if (result.candidateCount > 0) {
        lines.push(
          `扫描完成：${result.candidateCount} 个文件与 stable 完全重复，可释放约 ${fmtSize(result.reclaimableSize)}。`,
        );
        lines.push("点击“压缩空间”开始硬链接替换（再次扫描将重新计算）。");
        els.dedupeExecute.hidden = false;
        els.dedupeExecute.disabled = false;
        els.dedupeRun.textContent = "再次扫描";
      } else {
        lines.push("扫描完成：没有发现与 stable 重复的文件。");
        els.dedupeExecute.hidden = true;
      }
    } else {
      lines.push(
        `执行完成：已替换 ${result.linkedCount} 个文件，释放 ${fmtSize(result.linkedSize)}。`,
      );
      els.dedupeExecute.hidden = true;
    }
    if (result.skippedCrossVolumeCount > 0) {
      lines.push(
        `${result.skippedCrossVolumeCount} 个因跨分区无法硬链接（${fmtSize(result.skippedCrossVolumeSize)}）。`,
      );
    }
    if (result.failedCount > 0) lines.push(`${result.failedCount} 个失败。`);
    els.dedupeResult.textContent = lines.join(" ");
    els.dedupeProgressText.textContent = "完成";
    els.dedupeProgressFill.classList.remove("indeterminate");
    els.dedupeProgressFill.style.width = "100%";
  } catch (error) {
    els.dedupeResult.textContent = `失败:${error}`;
  } finally {
    dedupeRunning = false;
    els.dedupeRun.disabled = false;
    els.dedupeExecute.disabled = false;
    els.dedupeStop.hidden = true;
  }
}


// ---- 收藏夹管理：lazer 收藏夹 ↔ stable collection.db（osu-db 读写 + osu!.db 定位）----

interface BeatmapRef {
  md5: string;
  label: string;
  matched: boolean;
  cover: string | null;
  stableCover: string | null;
}
interface LazerCollectionInfo {
  name: string;
  matchedInStable: number;
  beatmaps: BeatmapRef[];
}
interface StableCollectionInfo {
  name: string;
  matchedInLazer: number;
  sampleFolder: string;
  beatmaps: BeatmapRef[];
}
interface CollectionPageData {
  stableDir: string;
  osuDbBeatmaps: number;
  lazerCollections: LazerCollectionInfo[];
  stableCollections: StableCollectionInfo[];
}

/** 渲染可展开的收藏夹表格：集合行（全选框）+ 展开后的谱面行（单张勾选、
 * shift 范围选择）。返回选择状态与全选/反选/取消 控制器。 */
interface ColumnController {
  selection: Map<string, Set<string>>;
  selectAll: () => void;
  invert: () => void;
  clear: () => void;
  /** 原地移除若干谱面并更新 DOM（保留展开状态），集合清空则整块移除。 */
  removeMd5s: (selections: { name: string; md5s: string[] }[]) => void;
  /** 取某收藏夹的全部谱面 MD5（与勾选状态无关，供右键整夹删除）。 */
  allMd5s: (name: string) => string[];
}

function renderCollectionTable(
  container: HTMLElement,
  collections: { name: string; beatmaps: BeatmapRef[] }[],
  defaultChecked: boolean,
): ColumnController {
  container.innerHTML = "";
  const selection = new Map<string, Set<string>>();
  let lastChecked: string | null = null;
  // shift 集合级选择：上次点击的收藏夹名 与 集合名→DOM块 映射。
  let lastCollectionName: string | null = null;
  const blocksByName = new Map<string, HTMLElement>();

  const syncMd5 = (box: HTMLInputElement) => {
    const entry = selection.get(box.dataset.collection!);
    if (!entry) return;
    if (box.checked) entry.add(box.dataset.md5!);
    else entry.delete(box.dataset.md5!);
  };

  for (const collection of collections) {
    const block = document.createElement("div");
    block.className = "collection-block";

    const header = document.createElement("div");
    header.className = "row slim collection-head";
    header.innerHTML = `
      <input type="checkbox"${defaultChecked ? " checked" : ""} />
      <div class="meta">
        <div class="title">${escapeHtml(collection.name)}</div>
        <div class="sub">${collection.beatmaps.length} 张谱面</div>
      </div>
      <button class="expand-btn" title="展开/收起">▸</button>`;
    block.appendChild(header);

    const beatmapList = document.createElement("div");
    beatmapList.className = "collection-beatmaps";
    beatmapList.style.display = "none";
    for (const beatmap of collection.beatmaps) {
      const row = document.createElement("div");
      row.className = "row slim beatmap-row";
      // 封面：lazer blob（可用 IPC 兜底）或 stable 谱面集文件夹里的图片（绝对路径直读）。
      let cover = "";
      if (!perfMode) {
        if (beatmap.cover) {
          cover = `<img class="cover" data-src="${coverUrl(beatmap.cover)}" data-hash="${beatmap.cover}" alt="" />`;
        } else if (beatmap.stableCover) {
          cover = `<img class="cover" data-src="${convertFileSrc(beatmap.stableCover)}" alt="" />`;
        }
      }
      row.innerHTML = `
        <input type="checkbox" data-md5="${beatmap.md5}" data-collection="${escapeHtml(collection.name)}"${defaultChecked ? " checked" : ""} />
        ${cover}
        <div class="meta">
          <div class="title">${escapeHtml(beatmap.label || beatmap.md5.slice(0, 12))}</div>
          <div class="sub">${beatmap.matched ? "" : "未获取到谱面数据 · "}${beatmap.md5.slice(0, 16)}…</div>
        </div>`;
      beatmapList.appendChild(row);
    }
    observeCoversIn(beatmapList);
    block.appendChild(beatmapList);
    container.appendChild(block);
    blocksByName.set(collection.name, block);

    selection.set(
      collection.name,
      new Set(defaultChecked ? collection.beatmaps.map((b) => b.md5) : []),
    );

    const allBox = header.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const syncAllBox = () => {
      const md5s = selection.get(collection.name)!;
      allBox.checked = md5s.size === collection.beatmaps.length;
    };

    // 展开/收起：独立的右侧按钮，与选择互不冲突。
    const expandBtn = header.querySelector<HTMLButtonElement>(".expand-btn")!;
    expandBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const expanded = beatmapList.style.display !== "none";
      beatmapList.style.display = expanded ? "none" : "flex";
      expandBtn.textContent = expanded ? "▸" : "▾";
    });

    // 集合全选框：复选框指针穿透，点击集合头（非箭头区域）切换全选/全不选。
    // shift 点击：从上一个点击的收藏夹到当前之间，整段收藏夹统一切换。
    const setCollectionState = (target: { name: string; beatmaps: BeatmapRef[] }, checked: boolean) => {
      const md5s = selection.get(target.name)!;
      md5s.clear();
      if (checked) target.beatmaps.forEach((b) => md5s.add(b.md5));
    };
    const applyHeadState = (target: { name: string; beatmaps: BeatmapRef[] }) => {
      const md5s = selection.get(target.name)!;
      const checked = md5s.size > 0;
      const block = blocksByName.get(target.name);
      block?.querySelectorAll<HTMLInputElement>('.beatmap-row input[type="checkbox"]').forEach(
        (box) => (box.checked = checked),
      );
      const head = block?.querySelector<HTMLInputElement>('.collection-head input[type="checkbox"]');
      if (head) head.checked = checked;
    };
    header.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".expand-btn")) return;
      if (event.shiftKey && lastCollectionName) {
        const order = collections.map((c) => c.name);
        const from = order.indexOf(lastCollectionName);
        const to = order.indexOf(collection.name);
        if (from >= 0 && to >= 0) {
          // 目标状态：当前收藏夹“是否未全选”→ 整段全选，否则整段取消。
          const current = selection.get(collection.name)!;
          const state = current.size !== collection.beatmaps.length;
          for (const name of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            const target = collections.find((c) => c.name === name)!;
            setCollectionState(target, state);
            applyHeadState(target);
          }
          return;
        }
      }
      lastCollectionName = collection.name;
      const md5s = selection.get(collection.name)!;
      const targetChecked = md5s.size !== collection.beatmaps.length;
      setCollectionState(collection, targetChecked);
      applyHeadState(collection);
    });

    // 复选框直接勾选。
    beatmapList.addEventListener("change", (event) => {
      const box = event.target as HTMLInputElement;
      if (box.tagName !== "INPUT") return;
      lastChecked = box.dataset.md5 ?? null;
      syncMd5(box);
      syncAllBox();
    });

    // 行点击（含 shift 范围选择）：范围按整列计算，锚点与目标可跨收藏夹。
    beatmapList.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".beatmap-row");
      if (!row) return;
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const boxes = Array.from(
        container.querySelectorAll<HTMLInputElement>('.beatmap-row input[type="checkbox"]'),
      );
      if (event.shiftKey && lastChecked) {
        const from = boxes.findIndex((b) => b.dataset.md5 === lastChecked);
        const to = boxes.indexOf(box);
        if (from >= 0 && to >= 0) {
          const state = !box.checked;
          for (const b of boxes.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            b.checked = state;
            syncMd5(b);
          }
          // 范围可能跨多个收藏夹：全部集合头重新对齐。
          for (const block of container.querySelectorAll<HTMLElement>(".collection-block")) {
            const head = block.querySelector<HTMLInputElement>(
              '.collection-head input[type="checkbox"]',
            )!;
            const first = block.querySelector<HTMLInputElement>(
              '.beatmap-row input[type="checkbox"]',
            );
            if (first?.dataset.collection) {
              const md5s = selection.get(first.dataset.collection);
              if (md5s) {
                const total = Array.from(
                  block.querySelectorAll<HTMLInputElement>(
                    '.beatmap-row input[type="checkbox"]',
                  ),
                );
                head.checked = md5s.size > 0 && md5s.size === total.length;
              }
            }
          }
          return;
        }
      }
      box.checked = !box.checked;
      lastChecked = box.dataset.md5 ?? null;
      syncMd5(box);
      syncAllBox();
    });
  }

  const allBoxes = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('.beatmap-row input[type="checkbox"]'));
  const refreshCollectionBoxes = () => {
    // 联动每个集合的全选框与谱面行勾选状态。
    for (const block of container.querySelectorAll<HTMLElement>(".collection-block")) {
      const allBox = block.querySelector<HTMLInputElement>('.collection-head input[type="checkbox"]')!;
      const boxes = Array.from(
        block.querySelectorAll<HTMLInputElement>('.beatmap-row input[type="checkbox"]'),
      );
      const collection = (boxes[0]?.dataset.collection ?? "");
      const md5s = selection.get(collection);
      if (!md5s) continue;
      boxes.forEach((box) => (box.checked = md5s.has(box.dataset.md5!)));
      allBox.checked = md5s.size > 0 && md5s.size === boxes.length;
    }
  };

  return {
    selection,
    selectAll() {
      for (const [name] of selection) {
        const collection = collections.find((c) => c.name === name)!;
        selection.set(name, new Set(collection.beatmaps.map((b) => b.md5)));
      }
      refreshCollectionBoxes();
    },
    invert() {
      for (const [name, md5s] of selection) {
        const collection = collections.find((c) => c.name === name)!;
        const all = collection.beatmaps.map((b) => b.md5);
        selection.set(
          name,
          new Set(all.filter((md5) => !md5s.has(md5))),
        );
      }
      refreshCollectionBoxes();
    },
    clear() {
      for (const [name] of selection) selection.set(name, new Set());
      refreshCollectionBoxes();
    },
    allMd5s(name: string) {
      return collections.find((c) => c.name === name)?.beatmaps.map((b) => b.md5) ?? [];
    },
    removeMd5s(target: { name: string; md5s: string[] }[]) {
      const removed = new Set(target.flatMap((item) => item.md5s));
      // 同步裁剪数据源，保证之后 全选/反选 的“全部”就是剩余谱面。
      for (const collection of collections) {
        if (target.some((item) => item.name === collection.name)) {
          collection.beatmaps = collection.beatmaps.filter((b) => !removed.has(b.md5));
        }
      }
      for (const item of target) {
        const block = blocksByName.get(item.name);
        const md5s = selection.get(item.name);
        if (!block || !md5s) continue;
        for (const md5 of item.md5s) {
          md5s.delete(md5);
          block
            .querySelector(`input[data-md5="${md5}"]`)
            ?.closest<HTMLElement>(".beatmap-row")
            ?.remove();
        }
        const remaining = block.querySelectorAll(".beatmap-row").length;
        if (remaining === 0) {
          block.remove();
          blocksByName.delete(item.name);
          selection.delete(item.name);
          continue;
        }
        const head = block.querySelector<HTMLInputElement>(
          '.collection-head input[type="checkbox"]',
        )!;
        head.checked = md5s.size > 0 && md5s.size === remaining;
        const sub = block.querySelector<HTMLElement>(".collection-head .sub");
        if (sub) sub.textContent = `${md5s.size}/${remaining} 张谱面已选`;
      }
    },
  };
}

/** 把 Map<集合, Set<MD5>> 折算成非空的后端选择参数。 */
function selectionToParam(
  selection: Map<string, Set<string>>,
): { name: string; md5s: string[] }[] {
  return [...selection.entries()]
    .map(([name, md5s]) => ({ name, md5s: [...md5s] }))
    .filter((entry) => entry.md5s.length > 0);
}

let lazerColumn: ColumnController | null = null;
let stableColumn: ColumnController | null = null;
// 最近一次读取的收藏夹页数据（无图模式切换时据此重渲染）。
let lastCollectionPage: CollectionPageData | null = null;

async function loadCollectionPage() {
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  if (!stableDir) return;
  els.collectionSummary.textContent = "正在读取（解析 client.realm / collection.db / osu!.db）…";
  els.collectionResult.textContent = "";
  try {
    const page = await invoke<CollectionPageData>("load_collection_page", { stableDir });
    els.collectionSummary.textContent =
      `stable 目录:${page.stableDir} · osu!.db 收录 ${page.osuDbBeatmaps.toLocaleString()} 张难度 · ` +
      `lazer 收藏夹 ${page.lazerCollections.length} 个 · collection.db 收藏夹 ${page.stableCollections.length} 个`;
    lastCollectionPage = page;
    lazerColumn = renderCollectionTable(els.lazerCollectionList, page.lazerCollections, true);
    stableColumn = renderCollectionTable(els.stableCollectionList, page.stableCollections, false);
  } catch (error) {
    els.collectionSummary.textContent = `读取失败:${error}`;
  }
}

function syncMode(): string {
  return (
    document.querySelector<HTMLInputElement>('input[name="sync-mode"]:checked')?.value ??
    "append"
  );
}

async function collectionResultOf(
  promise: Promise<{
    writtenCollections: number;
    written_hashes?: number;
    writtenHashes?: number;
    backup: string;
    folders_written?: number;
    foldersWritten?: number;
  }>,
  reload = true,
) {
  try {
    const result = await promise;
    const folders = result.foldersWritten ?? result.folders_written ?? 0;
    els.collectionResult.textContent =
      `完成（工作副本）：已复制到 ${result.backup}，现有 ${result.writtenCollections} 个收藏夹。` +
      (folders > 0 ? `已同时导出 ${folders} 个谱面集文件夹。` : "") +
      `原 collection.db 未被修改；点“导出 collection.db”可把它落到任意目录。`;
    if (reload) await loadCollectionPage();
  } catch (error) {
    els.collectionResult.textContent = `失败:${error}`;
  }
}

/** 删除类操作：后端写副本成功后原地更新列表，保留展开状态。 */
async function deleteInPlace(selections: { name: string; md5s: string[] }[], describe: string) {
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  const total = selections.reduce((sum, s) => sum + s.md5s.length, 0);
  if (!total) return;
  if (!confirm(`确定在工作副本上${describe}（共 ${total} 张谱面）？原 collection.db 不会改动。`)) return;
  await collectionResultOf(
    invoke("delete_stable_collections", { stableDir, selections }),
    false,
  );
  stableColumn?.removeMd5s(selections);
}


// ---- 事件绑定 ----

els.list.addEventListener("change", updateSelectionInfo);

// 行点击（含 shift 范围选择）：完全自管理，不经浏览器默认翻转。
// shift 点击：锚点行到当前行整段设为点击框的目标状态（未选中→全选，已选中→全不选）。
let lastCheckedId: string | null = null;
els.list.addEventListener("click", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
  if (!row) return;
  const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) return;
  const boxes = Array.from(
    els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
  if (event.shiftKey && lastCheckedId) {
    const from = boxes.findIndex((b) => b.dataset.id === lastCheckedId);
    const to = boxes.indexOf(box);
    if (from >= 0 && to >= 0) {
      const state = !box.checked;
      for (const b of boxes.slice(Math.min(from, to), Math.max(from, to) + 1)) {
        b.checked = state;
      }
      updateSelectionInfo();
      return;
    }
  }
  box.checked = !box.checked;
  lastCheckedId = box.dataset.id ?? null;
  updateSelectionInfo();
});
els.selectAll.addEventListener("click", () => {
  els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((b) => (b.checked = true));
  updateSelectionInfo();
});
els.selectNone.addEventListener("click", () => {
  els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((b) => (b.checked = false));
  updateSelectionInfo();
});
els.invertSelect.addEventListener("click", () => {
  els.list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((b) => (b.checked = !b.checked));
  updateSelectionInfo();
});
els.reload.addEventListener("click", load);
els.pageNav.addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>(".chip");
  if (!chip?.dataset.page) return;
  switchPage(chip.dataset.page as "export" | "space" | "collections" | "settings");
});
els.collectionLoad.addEventListener("click", async () => {
  // 重新读取 = 舍弃工作副本上的修改；读取时会从原 collection.db 重建副本。
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir && stableDir !== "未设置") {
    try {
      await invoke("discard_collection_changes", { stableDir });
    } catch {
      /* 无副本时忽略 */
    }
  }
  await loadCollectionPage();
});

// ---- stable 列右键删除（lazer 侧只读，不提供任何修改入口）----
const ctxMenu = document.getElementById("collection-context-menu")!;
let ctxBeatmap: { collection: string; md5: string } | null = null;
let ctxCollection: string | null = null;

function hideContextMenu() {
  ctxMenu.hidden = true;
  ctxBeatmap = null;
  ctxCollection = null;
}

function deleteViaContext(selections: { name: string; md5s: string[] }[], describe: string) {
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  const total = selections.reduce((sum, s) => sum + s.md5s.length, 0);
  if (!total) return;
  deleteInPlace(selections, describe);
}

els.stableCollectionList.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  // 阻止冒泡到 document 级的关闭器，否则菜单刚打开就被立即关闭。
  event.stopPropagation();
  hideContextMenu();
  const target = event.target as HTMLElement;
  const beatmapRow = target.closest<HTMLElement>(".beatmap-row");
  const head = target.closest<HTMLElement>(".collection-head");
  const beatmapButton = document.getElementById("ctx-delete-beatmap")!;
  const collectionButton = document.getElementById("ctx-delete-collection")!;
  if (beatmapRow) {
    const box = beatmapRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    ctxBeatmap = { collection: box.dataset.collection!, md5: box.dataset.md5! };
    ctxCollection = null;
    // 右键谱面：只显示“删除该谱面”。
    beatmapButton.hidden = false;
    collectionButton.hidden = true;
  } else if (head) {
    ctxCollection = head.querySelector<HTMLElement>(".title")?.textContent ?? null;
    // 右键收藏夹：只显示“删除该收藏夹”。
    beatmapButton.hidden = true;
    collectionButton.hidden = false;
  }
  if (!beatmapRow && !ctxCollection) return;
  ctxMenu.hidden = false;
  ctxMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  ctxMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 140)}px`;
});

document.addEventListener("click", (event) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(event.target as Node)) hideContextMenu();
});
document.addEventListener("contextmenu", (event) => {
  if (!ctxMenu.hidden && !ctxMenu.contains(event.target as Node)) hideContextMenu();
});
els.collectionDelete.addEventListener("click", () => {
  if (!stableColumn) return;
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  const selections = selectionToParam(stableColumn.selection);
  if (!selections.length) return;
  deleteViaContext(selections, "删除勾选的谱面");
});
document.getElementById("ctx-delete-beatmap")!.addEventListener("click", () => {
  const target = ctxBeatmap;
  if (!target) return hideContextMenu();
  hideContextMenu();
  deleteViaContext([{ name: target.collection, md5s: [target.md5] }], "删除该谱面");
});
document.getElementById("ctx-delete-collection")!.addEventListener("click", () => {
  const name = ctxCollection;
  hideContextMenu();
  if (!name || !stableColumn) return;
  // 右键整夹删除不依赖勾选状态：直接取该收藏夹全部谱面。
  const md5s = stableColumn.allMd5s(name);
  if (!md5s.length) return;
  deleteViaContext([{ name, md5s }], "删除该收藏夹");
});
document.getElementById("lazer-col-all")!.addEventListener("click", () => lazerColumn?.selectAll());
document.getElementById("lazer-col-invert")!.addEventListener("click", () => lazerColumn?.invert());
document.getElementById("lazer-col-none")!.addEventListener("click", () => lazerColumn?.clear());
document.getElementById("stable-col-all")!.addEventListener("click", () => stableColumn?.selectAll());
document.getElementById("stable-col-invert")!.addEventListener("click", () => stableColumn?.invert());
document.getElementById("stable-col-none")!.addEventListener("click", () => stableColumn?.clear());
els.collectionSync.addEventListener("click", () => {
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  if (!stableDir) return;
  if (!lazerColumn) return;
  const selections = selectionToParam(lazerColumn.selection);
  const mode = syncMode();
  if (
    mode === "replace" &&
    !confirm("替换模式会清空 collection.db 中未选中的内容，确定继续吗？")
  ) {
    return;
  }
  collectionResultOf(invoke("sync_collections", { stableDir, selections, mode }));
});
els.exportSelectedSets.addEventListener("click", () => {
  if (!lazerColumn) return;
  const md5s = [...lazerColumn.selection.values()].flatMap((set) => [...set]);
  if (!md5s.length) {
    els.collectionResult.textContent = "未选择任何谱面。";
    return;
  }
  // 与主导出同一套确认弹窗：格式/硬链接/覆盖/跳过全部生效后才执行。
  openExportModal({ ids: [], label: "谱面集（所选集合谱面）", md5s });
});
els.collectionExportCopy.addEventListener("click", async () => {
  const stableDir = els.stablePath.textContent.trim();
  if (stableDir === "未设置") return;
  // 保存对话框：可重命名、可选择替换既有文件。
  const target = await save({
    title: "导出 collection.db",
    defaultPath: "collection.db",
    filters: [{ name: "collection.db", extensions: ["db"] }],
  });
  if (!target) return;
  try {
    const path = await invoke<string>("export_collection_copy", {
      stableDir,
      targetFile: target,
    });
    els.collectionResult.textContent = `已导出到：${path}`;
  } catch (error) {
    els.collectionResult.textContent = `导出失败：${error}`;
  }
});

els.diskUsageBtn.addEventListener("click", showDiskUsage);
// 全选集合：把当前可见（受搜索过滤）的收藏夹全部加入多选；已全选则清空。
els.selectAllCollections.addEventListener("click", () => {
  if (!library) return;
  const query = els.navSearch.value.trim().toLowerCase();
  const visible = query
    ? library.collections.filter((c) => c.name.toLowerCase().includes(query))
    : library.collections;
  if (!visible.length) return;
  const current = collectionFilter instanceof Set ? collectionFilter : new Set<string>();
  const allSelected = visible.every((c) => current.has(c.name));
  if (allSelected) {
    const next = new Set(current);
    for (const c of visible) next.delete(c.name);
    collectionFilter = next.size ? next : null;
  } else {
    const next = new Set(current);
    for (const c of visible) next.add(c.name);
    collectionFilter = next;
  }
  renderSidebar();
  render();
});
els.dedupeRun.addEventListener("click", () => {
  els.dedupeExecute.hidden = true;
  runDedupe(true);
});
els.dedupeExecute.addEventListener("click", () => runDedupe(false));
els.dedupeStop.addEventListener("click", async () => {
  try {
    await invoke("cancel_dedupe");
  } catch {
    /* 忽略 */
  }
});
els.stopExport.addEventListener("click", stopExport);
els.exportingClose.addEventListener("click", requestCloseExporting);
els.progressWrap.addEventListener("click", (event) => {
  if (event.target === els.progressWrap) requestCloseExporting();
});
els.changeDir.addEventListener("click", changeDir);
els.lazerBrowse.addEventListener("click", changeDir);
// lazer 自动扫描：清除手动指定，回到默认目录检测逻辑并重新加载。
els.lazerAuto.addEventListener("click", async () => {
  try {
    const status = await invoke<LazerStatus>("set_lazer_data_dir", { path: null });
    els.lazerPath.textContent = status.filesRoot ?? status.dataRoot ?? "未检测到";
    try {
      localStorage.removeItem("lazer-dir");
    } catch {
      /* 忽略 */
    }
    if (!status.realmPath) {
      toast(`自动扫描未找到 client.realm（检测目录：${status.autoDataRoot ?? "?"}）`, false);
      return;
    }
    library = null;
    els.list.innerHTML = "";
    await load();
  } catch (error) {
    toast(`自动扫描失败：${error}`, false);
  }
});
els.stableAuto.addEventListener("click", async () => {
  try {
    const found = await invoke<string[]>("detect_stable_dir");
    if (!found.length) {
      toast("未扫描到 osu!stable 安装目录（Linux 查找 osu-wine 位置，Windows 查找注册表/LOCALAPPDATA）", false);
      return;
    }
    els.stablePath.textContent = found[0];
    try {
      localStorage.setItem("stable-dir", found[0]);
    } catch {
      /* 忽略持久化失败 */
    }
    updateStableDirDisplays();
  } catch (error) {
    toast(`自动扫描失败：${error}`, false);
  }
});
els.stableBrowse.addEventListener("click", async () => {
  const dir = await open({ directory: true, title: "选择 osu!stable 目录（根目录或 Songs 均可）" });
  if (!dir) return;
  els.stablePath.textContent = dir;
  try {
    localStorage.setItem("stable-dir", dir);
  } catch {
    /* 忽略持久化失败 */
  }
  updateStableDirDisplays();
});
els.resetDir.addEventListener("click", resetDir);
els.exportBtn.addEventListener("click", () => openExportModal());
els.exportConfirm.addEventListener("click", exportSelected);
els.exportBrowse.addEventListener("click", browseExportPath);
els.exportClose.addEventListener("click", closeExportModal);
els.exportCancel.addEventListener("click", closeExportModal);
els.exportModal.addEventListener("click", (event) => {
  if (event.target === els.exportModal) closeExportModal();
});
els.sidebar.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest(".nav-item");
  if (!btn) return;
  const el = btn as HTMLElement;
  // 谱面分类：未选中时切换到该分类并展开；已选中时点击折叠/展开收藏夹列表。
  if (el.classList.contains("category")) {
    tab = "beatmaps";
    refreshSortSelect();
    renderSidebar();
    render();
    return;
  }
  if (el.classList.contains("sub")) return;
  const newTab = el.dataset.tab as Tab | undefined;
  if (!newTab || newTab === tab) return;
  tab = newTab;
  refreshSortSelect();
  renderSidebar();
  render();
});
/** 输入去抖：停止输入 200ms 后才执行回调，避免每个按键都全量过滤渲染。 */
function debounce<F extends (...args: never[]) => void>(fn: F, delay = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<F>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

els.navSearch.addEventListener("input", debounce(renderSidebar));
els.rulesetFilter.addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLButtonElement>(".chip");
  if (!chip) return;
  rulesetFilter = chip.dataset.ruleset ?? "";
  els.rulesetFilter
    .querySelectorAll(".chip")
    .forEach((c) => c.classList.toggle("active", c === chip));
  render();
});
els.search.addEventListener("input", debounce(render));
els.unicodeMode.addEventListener("change", () => {
  unicodeMode = els.unicodeMode.checked;
  persistSetting("setting-unicode", unicodeMode);
  render();
});
els.perfMode.addEventListener("change", () => {
  perfMode = els.perfMode.checked;
  persistSetting("perfMode", perfMode);
  render();
  // 收藏夹管理页若已加载，按新开关重渲染两列。
  if (lastCollectionPage) {
    lazerColumn = renderCollectionTable(
      els.lazerCollectionList,
      lastCollectionPage.lazerCollections,
      true,
    );
    stableColumn = renderCollectionTable(
      els.stableCollectionList,
      lastCollectionPage.stableCollections,
      false,
    );
  }
});

els.sortKey.addEventListener("change", () => {
  sortKey = els.sortKey.value;
  render();
});
els.sortDir.addEventListener("click", () => {
  sortDesc = !sortDesc;
  els.sortDir.textContent = sortDesc ? "↓" : "↑";
  render();
});

await listen<{ phase: string; processed: number; total: number; percent: number }>(
  "dedupe-progress",
  (event) => {
    const { phase, processed, total, percent } = event.payload;
    els.dedupeProgressText.textContent = `${DEDUPE_PHASES[phase] ?? phase}（${processed}${
      total ? `/${total}` : ""
    }）`;
    if (total > 0) {
      els.dedupeProgressFill.classList.remove("indeterminate");
      els.dedupeProgressFill.style.width = `${percent}%`;
    } else {
      // 扫描阶段不知道总量：流动动画表示进行中
      els.dedupeProgressFill.classList.add("indeterminate");
      els.dedupeProgressFill.style.width = "";
    }
  },
);

await listen<{ done: number; total: number; name: string }>("export-progress", (event) => {
  const { done, total, name } = event.payload;
  setProgress(total ? done / total : 0, `(${done}/${total}) ${name}`);
});

restoreSettings();
// 恢复手动指定的 lazer 目录（localStorage 记忆），再加载库。
try {
  const savedLazerDir = localStorage.getItem("lazer-dir");
  if (savedLazerDir) {
    await invoke("set_lazer_data_dir", { path: savedLazerDir });
  }
} catch {
  /* 目录已失效时静默回退自动检测 */
}
try {
  const stableDir = localStorage.getItem("stable-dir");
  if (stableDir) els.stablePath.textContent = stableDir;
  updateStableDirDisplays();
} catch {
  /* 忽略 */
}
refreshSortSelect();
load();
