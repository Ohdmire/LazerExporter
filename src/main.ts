import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  resetDir: document.getElementById("reset-dir")!,
  navSearch: document.getElementById("nav-search") as HTMLInputElement,
  unicodeMode: document.getElementById("unicode-mode") as HTMLInputElement,
  perfMode: document.getElementById("perf-mode") as HTMLInputElement,
  settingsToggle: document.getElementById("settings-toggle")!,
  settingsModal: document.getElementById("settings-modal")!,
  settingsClose: document.getElementById("settings-close")!,
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
// beatmaps 子分类筛选：null = 全部，"__none__" = 未加入任何收藏夹，
// Set = 多选的收藏夹名集合（列表显示其并集）。
let collectionFilter: "__none__" | Set<string> | null = null;
// 谱面分类下的收藏夹列表是否展开。
let beatmapsExpanded = true;
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

function setStatus(text: string, ok: boolean | null = null) {
  els.status.textContent = text;
  els.status.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
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
function observeCovers() {
  coverObserver?.disconnect();
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
  els.list.querySelectorAll("img.cover[data-src]").forEach((img) => {
    coverObserver!.observe(img);
  });
}

// asset 协议加载失败时的兜底：走 IPC 读 blob 转 data URL（error 不冒泡，需捕获）。
els.list.addEventListener(
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
  els.selectionInfo.textContent = checked.length
    ? `已选 ${checked.length} 项（${fmtSize(size)}）`
    : "";
  els.exportBtn.disabled = checked.length === 0 || exporting;
}

function renderSidebar() {
  document.querySelectorAll("#sidebar .nav-item.category").forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle("active", el.dataset.tab === tab);
    el.querySelector(".arrow")!.textContent = beatmapsExpanded ? "▾" : "▸";
  });
  document
    .querySelectorAll("#sidebar .nav-item:not(.category):not(.sub)")
    .forEach((btn) => btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab));
  const nav = els.collectionNav;
  nav.innerHTML = "";
  const expanded = tab === "beatmaps" && beatmapsExpanded;
  nav.style.display = expanded ? "flex" : "none";
  els.navSearch.style.display = expanded ? "" : "none";
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
  setStatus("正在读取 client.realm…");
  try {
    const status = await invoke<LazerStatus>("detect_lazer");
    els.resetDir.hidden = !status.usingCustom;
    filesRoot = status.filesRoot;
    if (!status.realmPath) {
      setStatus(
        status.usingCustom
          ? `所选目录中没有 client.realm，请重新选择。`
          : `未找到 osu!lazer 数据目录（期望 ${status.dataRoot ?? "?"}）。可点击“选择目录”手动指定。`,
        false,
      );
      return;
    }
    const result = await invoke<{ realmPath: string; library: Library }>("list_library");
    library = result.library;
    coverBySetId.clear();
    for (const set of library.sets) {
      if (set.cover_hash) coverBySetId.set(set.id, set.cover_hash);
    }
    setStatus(
      `目录：${result.realmPath}${status.usingCustom ? "（手动指定）" : ""} · 谱面 ${library.sets.length} · 皮肤 ${library.skins.length} · 回放 ${library.scores.length}`,
      true,
    );
    renderSidebar();
    render();
  } catch (error) {
    setStatus(`读取失败：${error}`, false);
  }
}

async function changeDir() {
  const dir = await open({ directory: true, title: "选择 osu!lazer 数据目录（需包含 client.realm）" });
  if (!dir) return;
  try {
    await invoke("set_lazer_data_dir", { path: dir });
  } catch (error) {
    setStatus(`设置目录失败：${error}`, false);
    return;
  }
  library = null;
  els.list.innerHTML = "";
  await load();
}

async function resetDir() {
  try {
    await invoke("set_lazer_data_dir", { path: null });
  } catch (error) {
    setStatus(`恢复默认目录失败：${error}`, false);
    return;
  }
  library = null;
  els.list.innerHTML = "";
  await load();
}

// ---- 导出确认弹窗 ----

// 弹窗打开时暂存的待导出内容（点"开始导出"时使用）。
let pendingExport: { ids: string[]; label: string } | null = null;

const TYPE_LABELS: Record<Tab, string> = {
  beatmaps: "谱面（.osz）",
  skins: "皮肤（.osk）",
  replays: "回放（.osr）",
};

/** 打开导出确认弹窗：显示导出内容统计，路径记忆上次选择。 */
function openExportModal() {
  if (exporting || !library) return;
  const ids = selectedIds();
  if (!ids.length) return;
  const label = TYPE_LABELS[tab];
  const size = ids.reduce((sum, id) => sum + (sizeById.get(id) || 0), 0);
  pendingExport = { ids, label };
  els.exportSummary.textContent = `将导出 ${ids.length} 个${label}，共 ${fmtSize(size)}。`;
  let lastDir: string | null = null;
  try {
    lastDir = localStorage.getItem("export-dir");
  } catch {
    /* 忽略 */
  }
  els.exportPath.value = lastDir ?? "";
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
  const { ids, label } = pendingExport;
  const outDir = els.exportPath.value.trim();
  if (!outDir) return;

  const command =
    tab === "beatmaps" ? "export_sets" : tab === "skins" ? "export_skins" : "export_replays";
  const argName = tab === "beatmaps" ? "setIds" : tab === "skins" ? "skinIds" : "scoreIds";
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
  args[argName] = ids;

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
  // 直接点到 checkbox 本身时阻止浏览器默认翻转（行内其他位置没有默认行为）。
  if (event.target === box) event.preventDefault();
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
els.stopExport.addEventListener("click", stopExport);
els.exportingClose.addEventListener("click", requestCloseExporting);
els.progressWrap.addEventListener("click", (event) => {
  if (event.target === els.progressWrap) requestCloseExporting();
});
els.changeDir.addEventListener("click", changeDir);
els.resetDir.addEventListener("click", resetDir);
els.exportBtn.addEventListener("click", openExportModal);
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
    if (tab !== "beatmaps") {
      tab = "beatmaps";
    } else {
      beatmapsExpanded = !beatmapsExpanded;
    }
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
  persistSetting("setting-perf", perfMode);
  render();
});
els.settingsToggle.addEventListener("click", () => {
  els.settingsModal.hidden = false;
});
els.settingsClose.addEventListener("click", () => {
  els.settingsModal.hidden = true;
});
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) els.settingsModal.hidden = true;
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

await listen<{ done: number; total: number; name: string }>("export-progress", (event) => {
  const { done, total, name } = event.payload;
  setProgress(total ? done / total : 0, `(${done}/${total}) ${name}`);
});

restoreSettings();
refreshSortSelect();
load();
