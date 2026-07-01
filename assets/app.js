
// ==================== 数据岛 ====================
// 安全解析注入变量，防止 Python 替换失败导致 JS 崩溃
// [New Game]
const bundleByBid = {};
if (Array.isArray(bundleData)) {
bundleData.forEach(b => { bundleByBid[b.bid] = b; });
}
// 预打排序索引标签（避免 indexOf 导致 O(N²) 性能问题）
rawGameData.forEach((game, index) => { game._sortIndex = index; });
// 预建 ID → game 映射（O(1) 查找）
const gameById = {};
rawGameData.forEach(g => { gameById[g.id] = g; });
// ==================== 状态管理 ====================
// [V6.1] 默认过滤掉成人游戏
let displayData = rawGameData.filter(g => g.is_adult !== true);
let renderedCount = 0;
const BATCH_SIZE = 40;
let isLoading = false;
let searchDebounceTimer = null;
let cartSet = new Map(); // [购物车] Key: AppID, Value: { name, regionSubId, displayPrice, priceCny, coverUrl, discount, isLocked }
const cardGrid = document.getElementById('cardGrid');
const loader = document.getElementById('loader');
const stats = document.getElementById('stats');
const searchInput = document.getElementById('searchInput');
const navControls = document.getElementById('navControls');
const popover = document.getElementById('popover');
const popoverCover = document.getElementById('popoverCover');
const popoverTitle = document.getElementById('popoverTitle');
const popoverGrid = document.getElementById('popoverGrid');
// URL 压缩常量
const COVER_PREFIX = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/';
const COVER_SUFFIX = '/header.jpg';
const STORE_PREFIX = 'https://store.steampowered.com/app/';
// 前三名奖杯
const MEDAL_ICONS = ['https://cos.psnsgame.com/steamhl/assets/images/medal-gold.png', 'https://cos.psnsgame.com/steamhl/assets/images/medal-silver.png', 'https://cos.psnsgame.com/steamhl/assets/images/medal-copper.png'];
// 加密的作者链接
const ENCRYPTED_AUTHOR_URL = '==QN2YDO3YzMyYkMlUGbpZ2byBnRyUiclNXdGJTJwBXYGJTJuNmLlhWalh2bhlGeuc3d3ZkMlYkMlE0MlMHc0RHa';
// 成人游戏加密关键词
const ENCRYPTED_ADULT_KEY = '5IUJyIUJ2UUJ0gTJCJUJ5UUJ';
// 成人模式状态
let adultModeActive = false;
// [V7.2] 当前排序模式 & 愿望单优先开关
let currentSortType = 'default';
let wishlistPriority = false;
// [V7.0] 收藏游戏状态 (Set 类型) - 使用油猴脚本存储
const favorites = new Set();
let favoritesLoaded = false;
let favoritesTimeout = null;
// [V7.0] 引导模态框
function openGuideModal() {
document.getElementById('guideModal').classList.add('show');
}
function closeGuideModal() {
document.getElementById('guideModal').classList.remove('show');
}
// [V7.0] 请求油猴脚本加载收藏列表
function requestFavorites() {
// 检测是否为移动端或者非Mac/Windows平台，如果是，则跳过油猴脚本检测
const userAgent = navigator.userAgent || '';
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
const isMacOrWin = /Mac|Win/i.test(navigator.platform || '') || /Macintosh|Windows/i.test(userAgent);
if (isMobile || !isMacOrWin) {
console.log('📱 移动端或非Mac/Windows平台，跳过油猴脚本检测');
// 静默发出查询事件，以防万一其实有安装对应脚本
window.dispatchEvent(new CustomEvent('FAVORITES_QUERY'));
// 标记为已加载，防止后续操作认为未加载
favoritesLoaded = true;
return;
}
console.log('⭐ 向油猴请求收藏列表...');
window.dispatchEvent(new CustomEvent('FAVORITES_QUERY'));
// 500ms 超时检测
favoritesTimeout = setTimeout(function() {
if (!favoritesLoaded) {
console.warn('⚠️ 油猴脚本未响应，请检查配置');
alert('⚠️ 插件未连接\n\n请点击左上角「🎮 Steam 价格分析」Logo 查看配置指南');
openGuideModal();
}
}, 500);
}
// [V7.0] 监听油猴返回的收藏列表
window.addEventListener('FAVORITES_RESPONSE', function(e) {
// 清除超时检测
if (favoritesTimeout) {
clearTimeout(favoritesTimeout);
favoritesTimeout = null;
}
const favData = e.detail.favorites || [];
favData.forEach(id => favorites.add(id));
favoritesLoaded = true;
console.log(`⭐ 从油猴加载 ${favorites.size} 个收藏游戏`);
// 重新排序并渲染（createCardHTML 会检查 favorites 设置正确的样式）
applyDefaultSort();
});
// [V7.0] 保存收藏列表到油猴
function saveFavoritesToTampermonkey() {
window.dispatchEvent(new CustomEvent('FAVORITES_UPDATE', {
detail: [...favorites]
}));
}
// [V7.0] 更新所有卡片的收藏 UI
function updateFavoriteUI() {
document.querySelectorAll('.game-card').forEach(card => {
const idx = parseInt(card.dataset.idx);
if (idx >= 0 && idx < displayData.length) {
const game = displayData[idx];
const isFav = favorites.has(game.id);
card.classList.toggle('favorite', isFav);
const btn = card.querySelector('.star-btn');
if (btn) btn.classList.toggle('active', isFav);
}
});
}
// [V7.0] 复杂排序比较函数 (复刻 Python 逻辑)
function compareComplex(a, b) {
// 1. Is Unlocked (Bool)
// Python: 1 if cp is not None else 0
const uA = (a.cp !== null) ? 1 : 0;
const uB = (b.cp !== null) ? 1 : 0;
if (uA !== uB) return uB - uA; // Desc
// 2. 优先度升级: 史低打标 (hl_priority)
const getHlPriority = (g) => {
const hl = g.hl || 0;
const hasD = (g.d && g.d !== '0');
const rc = g.rc || 0;
if (!hasD) return 0;
if (hl === 1) {
if (rc > 5000) return 4;
return 3;
}
if (hl === 2) return 3;
if (hl === 3) return 2;
return 1;
};
const hlA = getHlPriority(a);
const hlB = getHlPriority(b);
if (hlA !== hlB) return hlB - hlA; // Desc
// 3. Diff Tier (int // 10)
const dfA = Math.floor((a.df || 0) / 10);
const dfB = Math.floor((b.df || 0) / 10);
if (dfA !== dfB) return dfB - dfA; // Desc
// 4. Review Tier (int // 1000)
const rcA = Math.floor((a.rc || 0) / 1000);
const rcB = Math.floor((b.rc || 0) / 1000);
if (rcA !== rcB) return rcB - rcA; // Desc
// 5. Positive Rate
return (b.r || 0) - (a.r || 0); // Desc
}
// 系列区块重组（默认排序专用）：
// 遍历已排序数组，遇到系列成员时，仅将同系列中"有折扣"的游戏拉到锚点位置聚合；
// 无折扣的系列游戏不提前聚合，保留在自然排序位置。
function applySeriesBlocks(data) {
if (!SERIES_MAP || Object.keys(SERIES_MAP).length === 0) return data;
const dataSet = new Set(data.map(g => g.id));
const result = [];
const added = new Set();
// 判断游戏是否有有效折扣
const hasDiscount = (game) => {
const d = game.d;
return d && d !== '0';
};
for (const g of data) {
if (added.has(g.id)) continue;
const sn = SERIES_MAP[String(g.id)];
if (sn) {
// 仅聚合同系列中"有折扣"的游戏（仅限当前 data 中存在的），按 _sortIndex 升序
const siblings = (SERIES_GROUPS[sn] || [])
.filter(sid => dataSet.has(sid) && !added.has(sid));
const siblingGames = siblings
.map(sid => gameById[sid])
.filter(Boolean)
.filter(sg => hasDiscount(sg))
.sort((a, b) => a._sortIndex - b._sortIndex);
for (const sg of siblingGames) {
result.push(sg);
added.add(sg.id);
}
// 当前游戏本身若未被聚合（无折扣），按普通游戏处理
if (!added.has(g.id)) {
result.push(g);
added.add(g.id);
}
} else {
result.push(g);
added.add(g.id);
}
}
return result;
}
// [V1.2] 缓存 TOP100 数据避免重复拉取
let globalTop100Cache = null;
// [V7.2] 统一渲染流水线
function refreshDisplay() {
// Step 1: 搜索过滤
const keyword = searchInput.value.trim();
const keywordLower = keyword.toLowerCase();
let data = [];
// 特殊关键词处理
const encryptedInput = encryptKey(keyword);
if ((encryptedInput && encryptedInput === ENCRYPTED_ADULT_KEY) || 
['黄游', '18+'].includes(keyword)) {
adultModeActive = true;
data = rawGameData.filter(g => g.is_adult === true);
// [黄油模式] 动态更新子分类按钮文本
if (filterModeCheaper) filterModeCheaper.textContent = '📉 比港区低';
cardGrid.style.display = '';
bundleView.style.display = 'none';
document.querySelectorAll('.search-divider').forEach(el => el.remove());
} else if (['视觉小说', 'galgame', 'gal'].includes(keywordLower)) {
data = rawGameData.filter(g => visualNovelAppIds.has(String(g.id)));
cardGrid.style.display = '';
bundleView.style.display = 'none';
document.querySelectorAll('.search-divider').forEach(el => el.remove());
} else if (!keyword) {
// 空搜索 ->遵循 adultMode
data = getBaseData();
// 退出黄油模式时恢复按钮文本
if (!adultModeActive && filterModeCheaper) filterModeCheaper.textContent = '📉 比国区低';
} else {
// 普通搜索 (忽略 adultMode, 强制显示匹配项)
adultModeActive = false;
if (filterModeCheaper) filterModeCheaper.textContent = '📉 比国区低';
// [V7.3] 单品游戏初步匹配
data = rawGameData.filter(game => {
const searchName = game.ne || '';
return game.n.toLowerCase().includes(keywordLower) ||
searchName.toLowerCase().includes(keywordLower) ||
String(game.id).includes(keyword);
});
// [新增: 系列联动查找]
let matchedSeries = new Set();
data.forEach(g => {
const sName = SERIES_MAP[String(g.id)];
if (sName) matchedSeries.add(sName);
});
if (matchedSeries.size > 0) {
const baseData = getBaseData();
const existingIds = new Set(data.map(g => g.id));
baseData.forEach(bg => {
const sName = SERIES_MAP[String(bg.id)];
if (sName && matchedSeries.has(sName) && !existingIds.has(bg.id)) {
data.push(bg);
existingIds.add(bg.id);
}
});
}
// [V7.3] 捆绑包初步匹配
let matchedBundles = bundleData.filter(b => {
return b.n.toLowerCase().includes(keywordLower) || String(b.bid).includes(keyword);
});
const linkedGames = new Set(data.map(g => g.id));
const linkedBundles = new Set(matchedBundles.map(b => b.bid));
// 1. 游戏关联的捆绑包 (搜索单品命中时，带出它所在的捆绑包)
data.forEach(g => {
const bids = GAME_TO_BUNDLES[g.id] || [];
bids.forEach(bid => {
if (!linkedBundles.has(bid) && bundleByBid[bid]) {
matchedBundles.push(bundleByBid[bid]);
linkedBundles.add(bid);
}
});
});
// 2. 捆绑包关联的游戏 (搜索捆绑包命中时，带出它包含的单品)
matchedBundles.forEach(b => {
(b.bl || []).forEach(aid => {
if (!linkedGames.has(aid) && gameById[aid]) {
data.push(gameById[aid]);
linkedGames.add(aid);
}
});
});
// 按预打标签恢复原排序（极速 O(N log N)）
data.sort((a, b) => a._sortIndex - b._sortIndex);
matchedBundles.sort((a, b) => (b.df || 0) - (a.df || 0)); // 捆绑包默认按差价降序
// [V7.3] 联动的 DOM 控制：如果有搜索词，并且两个都有结果，那就都展示
const hasBundles = matchedBundles.length > 0;
const hasGames = data.length > 0;
if (hasBundles) {
bundleView.style.display = 'block';
renderBundleGrid(matchedBundles);
// 若只有 1 个捆绑包，采用居中布局美化
if (matchedBundles.length === 1) {
bundleGrid.style.justifyContent = 'center';
} else {
bundleGrid.style.justifyContent = ''; // 恢复默认
}
} else {
bundleView.style.display = 'none';
}
if (hasGames) {
cardGrid.style.display = '';
loader.style.display = 'block';
} else {
cardGrid.style.display = 'none';
loader.style.display = 'none';
}
// [UI优化] 动态插入分界线（需清除掉历史可能存在的分界线防重复）
document.querySelectorAll('.search-divider').forEach(el => el.remove());
if (hasBundles && hasGames) {
const bundleDivider = document.createElement('div');
bundleDivider.className = 'search-divider';
bundleDivider.style.cssText = 'width:100%; text-align:center; font-size:18px; font-weight:bold; color:#a4d007; margin: 20px 0 10px 0; border-bottom: 1px dashed rgba(164, 208, 7, 0.4); padding-bottom: 5px; letter-spacing: 2px; text-shadow: 0 0 8px rgba(164, 208, 7, 0.5);';
bundleDivider.textContent = '—— 游戏捆绑包 ——';
bundleView.insertBefore(bundleDivider, bundleGrid);
const gameDivider = document.createElement('div');
gameDivider.className = 'search-divider';
gameDivider.style.cssText = 'width:100%; text-align:center; font-size:18px; font-weight:bold; color:#66c0f4; margin: 20px 0 10px 0; border-bottom: 1px dashed rgba(102, 192, 244, 0.4); padding-bottom: 5px; letter-spacing: 2px; text-shadow: 0 0 8px rgba(102, 192, 244, 0.5);';
gameDivider.textContent = '—— 单品游戏 ——';
// 将单品分界线直接插在 cardGrid 之前
cardGrid.parentNode.insertBefore(gameDivider, cardGrid);
}
}
// [TOP100] 热榜集成到标准流
if (currentSortType === 'top100') {
if (globalTop100Cache === null) {
// 第一次拉取：中断当前渲染，向油猴请求全量匹配
loader.style.display = 'block';
cardGrid.style.display = 'none';
bundleView.style.display = 'none';
// 数据泵模式：传入全量 ID 对比，防止缓存污染
const validAppIds = Object.keys(gameById);
window.dispatchEvent(new CustomEvent('STEAM_FETCH_TOP100', {
detail: { validAppIds: validAppIds }
}));
if (stats) stats.textContent = '🔥 正在拉取 TOP100 热榜...';
return; 
}
// 已有缓存：通过缓存映射数据，并继续后续的标准流水线（筛选/排序）
data = globalTop100Cache.map(id => gameById[id]).filter(Boolean);
}
// Step 2: 获取高级筛选参数 (防止为空时卡死)
const hideOwned = document.getElementById('hideOwnedCheckPanel')?.checked || false;
const wishlistPriority = document.getElementById('wishlistPriorityCheckPanel')?.checked || false;
const toleranceInputEl = document.getElementById('toleranceInput');
const userTolerance = toleranceInputEl ? parseFloat(toleranceInputEl.value) || 0 : 0;
const strictLowest = userTolerance === 0;
const top3Check = document.getElementById('top3CheckPanel')?.checked ?? true;
const hlNew = document.getElementById('hlNewCheck')?.checked || false;
const hlEqual = document.getElementById('hlEqualCheck')?.checked || false;
const hlNon = document.getElementById('hlNonCheck')?.checked || false;
const minPriceEl = document.getElementById('filterPriceMin');
const minPrice = minPriceEl ? (parseFloat(minPriceEl.value) || 0) : 0;
const maxPriceEl = document.getElementById('filterPriceMax');
const maxPriceStr = maxPriceEl ? maxPriceEl.value : '';
const maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : Infinity;
const filterRateMinEl = document.getElementById('filterRateMin');
const rateMin = filterRateMinEl ? (parseFloat(filterRateMinEl.value) || 0) : 0;
const filterRateMaxEl = document.getElementById('filterRateMax');
const rateMaxStr = filterRateMaxEl ? filterRateMaxEl.value : '';
const rateMax = rateMaxStr ? parseFloat(rateMaxStr) : 100;
const rcMinEl = document.getElementById('filterRcMin');
const rcMin = rcMinEl ? (parseFloat(rcMinEl.value) || 0) : 0;
const rcMaxEl = document.getElementById('filterRcMax');
const rcMaxStr = rcMaxEl ? rcMaxEl.value : '';
const rcMax = rcMaxStr ? parseFloat(rcMaxStr) : Infinity;
const diffMinEl = document.getElementById('diffMin');
const diffMinStr = diffMinEl ? diffMinEl.value : '';
const diffMin = diffMinStr ? parseFloat(diffMinStr) : -Infinity;
const diffMaxEl = document.getElementById('diffMax');
const diffMaxStr = diffMaxEl ? diffMaxEl.value : '';
const diffMax = diffMaxStr ? parseFloat(diffMaxStr) : Infinity;
const diffTypeSelect = document.getElementById('diffTypeSelect');
const diffType = diffTypeSelect ? diffTypeSelect.value : 'absolute';
const flagEl = document.getElementById('filterPanelRegionFlag');
const filterRegionCode = flagEl ? (flagEl.getAttribute('data-code') || 'cn') : 'cn';
const giftFilterCheckbox = document.getElementById('giftFilterCheckbox');
const onlyGifting = giftFilterCheckbox ? giftFilterCheckbox.checked : false;
// 更新悬浮按钮状态
let activeFilterCount = 0;
if (hideOwned) activeFilterCount++;
if (wishlistPriority) activeFilterCount++;
if (strictLowest) activeFilterCount++;
if (!top3Check) activeFilterCount++;
if (hlNew || hlEqual || hlNon) activeFilterCount++;
if (minPrice > 0 || isFinite(maxPrice)) activeFilterCount++;
if (rateMin > 0 || (rateMaxStr !== '' && rateMax < 100)) activeFilterCount++;
if (rcMin > 0 || isFinite(rcMax)) activeFilterCount++;
if (onlyGifting || (isFinite(diffMin) && diffMin > -Infinity) || isFinite(diffMax)) activeFilterCount++;
const badgeDesktop = document.getElementById('filterBadgeDesktop');
const badgeMobile = document.getElementById('filterBadgeMobile');
const mainBtnDesktop = document.getElementById('mainFilterBtnDesktop');
const mainBtnMobile = document.getElementById('mainFilterBtnMobile');
if (activeFilterCount > 0) {
if (badgeDesktop) { badgeDesktop.textContent = activeFilterCount; badgeDesktop.style.display = 'block'; }
if (badgeMobile) { badgeMobile.textContent = activeFilterCount; badgeMobile.style.display = 'block'; }
if (mainBtnDesktop) mainBtnDesktop.classList.add('active');
if (mainBtnMobile) mainBtnMobile.classList.add('active');
} else {
if (badgeDesktop) badgeDesktop.style.display = 'none';
if (badgeMobile) badgeMobile.style.display = 'none';
if (mainBtnDesktop) mainBtnDesktop.classList.remove('active');
if (mainBtnMobile) mainBtnMobile.classList.remove('active');
}
// [逻辑整合]
// 如果搜索清空，恢复原始视图状态
if (!keyword) {
document.querySelectorAll('.search-divider').forEach(el => el.remove());
bundleGrid.style.justifyContent = ''; // 恢复默认布局
if (bundleMode) {
bundleView.style.display = 'block';
cardGrid.style.display = 'none';
loader.style.display = 'none';
renderBundleGrid(bundleData);
} else {
bundleView.style.display = 'none';
cardGrid.style.display = '';
loader.style.display = 'none';
}
}
// 基础过滤 (Hide Owned)
if (hideOwned) {
data = data.filter(g => !userLibrary.owned.has(g.id) && !userLibrary.familyMap.has(g.id));
}
// 史低过滤 (若勾选任何一项则开启过滤)
if (hlNew || hlEqual || hlNon) {
data = data.filter(g => {
const tag = g.hl || 0;
if (hlNew && tag === 1) return true;
if (hlEqual && tag === 2) return true;
if (hlNon && (tag === 0 || tag === 3)) return true;
return false;
});
}
// 评价率过滤 (好评率范围)
if (rateMin > 0 || rateMax < 100) {
data = data.filter(g => {
const r = g.r || 0;
return r >= rateMin && r <= rateMax;
});
}
// 评测量过滤
if (rcMin > 0 || isFinite(rcMax)) {
data = data.filter(g => {
const rc = g.rc || 0;
return rc >= rcMin && rc <= rcMax;
});
}
// 价格范围过滤 (汇率逆推法：将外币区间折算为CNY阈值，直接比较pd[1])
if (minPrice > 0 || isFinite(maxPrice)) {
const targetRegIdx = REGIONS_NON_CN.findIndex(r => r.code === filterRegionCode);
// 计算CNY阈值
let minCny = 0;
let maxCny = Infinity;
if (filterRegionCode === 'cn') {
// 国区：用户输入即为CNY，无需转换
minCny = minPrice;
maxCny = maxPrice;
} else {
// 非国区：通过汇率将外币区间折算为CNY
const ccEntry = JS_CC_LIST.find(c => c[0] === filterRegionCode);
const currencyCode = ccEntry ? ccEntry[2] : null;
const rate = currencyCode ? (EXCHANGE_RATES[currencyCode] || 0) : 0;
if (rate > 0) {
minCny = minPrice * rate;
maxCny = isFinite(maxPrice) ? maxPrice * rate : Infinity;
}
}
data = data.filter(g => {
if (filterRegionCode === 'cn') {
const gameCny = g.cp;
if (gameCny === null || gameCny === undefined) return false;
return gameCny >= minCny && gameCny <= maxCny;
} else if (targetRegIdx !== -1) {
const pd = g.ap && g.ap[targetRegIdx];
if (!pd || pd === 0) return false; // 该区无价格
const gameCny = pd[1];
if (gameCny === null || gameCny === undefined) return false;
return gameCny >= minCny && gameCny <= maxCny;
} else {
return false;
}
});
}
// 与国区差价及赠礼过滤
if (onlyGifting || (isFinite(diffMin) && diffMin > -Infinity) || isFinite(diffMax)) {
const targetRegIdx = REGIONS_NON_CN.findIndex(r => r.code === filterRegionCode);
data = data.filter(g => {
let cnPrice = g.cp;
let regPrice = null;
if (filterRegionCode === 'cn') {
regPrice = cnPrice;
} else if (targetRegIdx !== -1) {
const pd = g.ap && g.ap[targetRegIdx];
if (pd && pd !== 0) regPrice = pd[1];
}
if (cnPrice === null || regPrice === null) return false;
// 方案A：如果勾选了仅显示跨区送礼
if (onlyGifting) {
// 发送方为选中地区(regPrice)，接收方为国区(cnPrice)
if (regPrice > cnPrice) return true; // 价格低于国区，随便送 (green)
const diffRate = (cnPrice - regPrice) / regPrice;
// <= 0.15 即大概率或可能可送（绿和黄）
return diffRate <= 0.15;
}
if (diffType === 'percent' && cnPrice === 0) return false;
let diffValue;
if (diffType === 'percent') {
diffValue = ((cnPrice - regPrice) / cnPrice) * 100;
} else {
diffValue = cnPrice - regPrice;
}
return diffValue >= diffMin && diffValue <= diffMax;
});
}
// Step 3: 排序规则 (Search/Sort/Region)
// 如果是地区筛选模式，特殊处理
if (currentRegionFilter) {
applyRegionFilter(data); // 传入经过 Step1/2 过滤的数据
return; // region filter handles rendering
}
// [New Game] 2026年发售排序处理
if (currentSortType === 'new2026') {
// 使用已经经过高级筛选的 data，再过滤 2026 年发售的游戏
data = data.filter(g => {
const rDate = newGamesMap[g.id];
return rDate && rDate.startsWith('2026');
});
}
// 通用排序
const sortType = currentSortType;
data.sort((a, b) => {
const aFav = favorites.has(a.id) ? 1 : 0;
const bFav = favorites.has(b.id) ? 1 : 0;
// 第一优先级：收藏游戏置顶
if (bFav !== aFav) return bFav - aFav;
// 第二优先级：愿望单优先 (仅当高级筛选开关开启时)
if (wishlistPriority) {
const aWish = userLibrary.wishlist.has(a.id) || userLibrary.familyWishlistMap.has(a.id) ? 1 : 0;
const bWish = userLibrary.wishlist.has(b.id) || userLibrary.familyWishlistMap.has(b.id) ? 1 : 0;
if (bWish !== aWish) return bWish - aWish;
}
// 第三优先级：具体排序逻辑
// [V1.1.4] top100 模式：按官方排名排序
if (sortType === 'top100') {
return (a._top100Rank || 999) - (b._top100Rank || 999);
}
// [V1.1.4] new2026 模式：按发售日期降序排列
if (sortType === 'new2026') {
return (newGamesMap[b.id] || "").localeCompare(newGamesMap[a.id] || "");
}
// [V7.2] 地区筛选模式下的特殊排序 (Dynamic Diff)
if (currentRegionFilter && currentRegionFilter !== 'cn') {
const sortCode = currentRegionFilter;
const regionIdx = REGIONS_NON_CN.findIndex(r => r.code === sortCode);
if (regionIdx !== -1) {
// 按当前地区差价降序
const diffA = getRegionDiff(a, regionIdx);
const diffB = getRegionDiff(b, regionIdx);
if (diffA !== diffB) return diffB - diffA;
// 差价相同，按好评率
return (b.r || 0) - (a.r || 0);
}
}
if (sortType === 'rate') {
// 好评排序
const tierA = Math.floor(a.rc / 1000);
const tierB = Math.floor(b.rc / 1000);
if (tierA !== tierB) return tierB - tierA;
return (b.r || 0) - (a.r || 0);
} else if (sortType === 'diff') {
// 差价梯队
const tierA = Math.floor((a.df || 0) / 5);
const tierB = Math.floor((b.df || 0) / 5);
if (tierB !== tierA) return tierB - tierA;
return a._sortIndex - b._sortIndex;
} else if (sortType === 'discount') {
// 折扣
const discA = parseDiscount(a.d);
const discB = parseDiscount(b.d);
if (discB !== discA) return discB - discA;
return a._sortIndex - b._sortIndex;
} else if (sortType === 'reviewCount') {
// 评价数量排序（按评价数降序，相同则按好评率降序）
const rcA = a.rc || 0;
const rcB = b.rc || 0;
if (rcB !== rcA) return rcB - rcA;
return (b.r || 0) - (a.r || 0);
} else {
// Default: 复杂排序
return compareComplex(a, b);
}
});
// 系列不可分割区块重组 (Top100 / 2026年发售 / 评价数量 禁用系列视图以保持榜单准确性)
if (currentSortType !== 'top100' && currentSortType !== 'new2026' && currentSortType !== 'reviewCount') {
data = applySeriesBlocks(data);
}
displayData = data;
resetAndRender();
}
// [V7.0] 兼容旧调用 -> 指向 refreshDisplay
function applyDefaultSort() {
currentSortType = 'default';
refreshDisplay();
}
// [V7.0] 切换收藏状态
function toggleFavorite(event, gameId) {
event.stopPropagation();
const id = parseInt(gameId);
const card = event.target.closest('.game-card');
const btn = event.currentTarget;
if (favorites.has(id)) {
favorites.delete(id);
if (card) card.classList.remove('favorite');
btn.classList.remove('active');
} else {
favorites.add(id);
if (card) card.classList.add('favorite');
btn.classList.add('active');
}
// 保存到油猴
saveFavoritesToTampermonkey();
}
// 页面加载完成后请求关注列表
setTimeout(requestFavorites, 100);
// 解密作者链接并跳转
function openAuthorPage() {
try {
// 逆向解密: 反转 -> Base64解码 -> URL解码
const reversed = ENCRYPTED_AUTHOR_URL.split('').reverse().join('');
const decoded = atob(reversed);
const url = decodeURIComponent(decoded);
window.open(url, '_blank');
} catch (e) {
console.error('链接解密失败');
}
}
// ==================== 第三方 CDK 价格请求 (事件驱动模式) ====================
// 已获取过CDK价格的游戏ID集合（避免重复请求）
const fetchedCDKGames = new Set();
// 兜底定时器存储
const fallbackTimers = {};
// CORS 代理前缀（兜底）
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
// 发送 Epic 地区比价请求信号给油猴脚本
function fetchEpicRegionalPrices(gameName, containerId) {
if (!gameName) return;
const container = document.getElementById(containerId);
if (!container) return;
console.log('📡 [网页] 发送 Epic 查价请求:', gameName);
window.dispatchEvent(new CustomEvent('EPIC_PRICE_REQUEST', {
detail: { gameName, containerId }
}));
fallbackTimers[containerId] = setTimeout(() => {
const statusEl = container.querySelector('.epic-query-status');
if (statusEl && statusEl.textContent === '查询中...') {
statusEl.textContent = '未连接油猴';
statusEl.style.color = '#ff6b6b';
}
}, 3000);
}
// 发送请求信号给油猴脚本
function fetchThirdPartyPrices(appId, subId, containerId) {
// 如果没有 SubID，不请求
if (!subId) return;
const container = document.getElementById(containerId);
if (!container) return;
// 发送自定义事件给油猴脚本（使用 window 对象避免隔离）
console.log('📡 [网页] 发送查价请求:', appId, subId);
window.dispatchEvent(new CustomEvent('STEAMPY_REQUEST', {
detail: { appId, subId, containerId }
}));
// 兜底逻辑：2秒后如果价格未更新，使用 CORS 代理
fallbackTimers[containerId] = setTimeout(() => {
const pyPriceEl = container.querySelector('.py-price');
const ciciPriceEl = container.querySelector('.cici-price');
// 检查是否仍在加载中（说明油猴脚本未响应）
if (pyPriceEl && pyPriceEl.classList.contains('loading')) {
fetchWithCORSProxy('py', appId, subId, containerId);
}
if (ciciPriceEl && ciciPriceEl.classList.contains('loading')) {
fetchWithCORSProxy('cici', appId, subId, containerId);
}
}, 2000);
}
// CORS 代理兜底请求
async function fetchWithCORSProxy(platform, appId, subId, containerId) {
const container = document.getElementById(containerId);
if (!container) return;
if (platform === 'py') {
const pyPriceEl = container.querySelector('.py-price');
const pyUrl = `https://steampy.com/xboot/common/plugIn/getGame?subId=${subId}&appId=${appId}&type=subid`;
try {
const pyRes = await fetch(CORS_PROXY + encodeURIComponent(pyUrl));
if (pyRes.ok) {
const pyData = await pyRes.json();
if (pyData.success && pyData.result) {
const { keyPrice, id } = pyData.result;
if (pyPriceEl) {
pyPriceEl.textContent = keyPrice ? `¥${keyPrice}` : '暂无';
pyPriceEl.classList.remove('loading');
const pyItem = pyPriceEl.closest('.thirdparty-item');
if (pyItem && id) {
pyItem.setAttribute('data-url', `https://steampy.com/cdkDetail?name=cn&gameId=${id}`);
pyItem.onclick = function() { window.open(this.getAttribute('data-url'), '_blank'); };
}
}
} else {
if (pyPriceEl) { pyPriceEl.textContent = '未找到'; pyPriceEl.classList.remove('loading'); }
}
} else {
if (pyPriceEl) { pyPriceEl.textContent = '请求失败'; pyPriceEl.classList.add('error'); pyPriceEl.classList.remove('loading'); }
}
} catch (e) {
if (pyPriceEl) { pyPriceEl.textContent = '代理失败'; pyPriceEl.classList.add('error'); pyPriceEl.classList.remove('loading'); }
}
} else if (platform === 'cici') {
const ciciPriceEl = container.querySelector('.cici-price');
const ciciUrl = `https://steamcici.com/prod-api/user/system/shopGame/list?parentId=${appId}`;
try {
const ciciRes = await fetch(CORS_PROXY + encodeURIComponent(ciciUrl));
if (ciciRes.ok) {
const ciciData = await ciciRes.json();
if (ciciData.code === 200 && ciciData.rows) {
const gameData = ciciData.rows.find(item => String(item.gameId) === String(subId));
if (gameData && gameData.lastLowSellPrice !== null) {
if (ciciPriceEl) {
ciciPriceEl.textContent = `¥${gameData.lastLowSellPrice}`;
ciciPriceEl.classList.remove('loading');
}
} else {
if (ciciPriceEl) { ciciPriceEl.textContent = '暂无上架'; ciciPriceEl.classList.remove('loading'); }
}
} else {
if (ciciPriceEl) { ciciPriceEl.textContent = '未找到'; ciciPriceEl.classList.remove('loading'); }
}
} else {
if (ciciPriceEl) { ciciPriceEl.textContent = '请求失败'; ciciPriceEl.classList.add('error'); ciciPriceEl.classList.remove('loading'); }
}
} catch (e) {
if (ciciPriceEl) { ciciPriceEl.textContent = '代理失败'; ciciPriceEl.classList.add('error'); ciciPriceEl.classList.remove('loading'); }
}
}
}
// ==================== 接收油猴脚本 V3.0 的响应 ====================
window.addEventListener('STEAMPY_RESPONSE', function(e) {
console.log('✅ [网页] 收到油猴响应 (SteamPY):', e.detail);
const { containerId, success, data } = e.detail;
const container = document.getElementById(containerId);
if (!container) return;
// 清除兜底定时器，避免重复刷新
if (fallbackTimers[containerId]) {
clearTimeout(fallbackTimers[containerId]);
delete fallbackTimers[containerId];
}
const pyPriceEl = container.querySelector('.py-price');
if (pyPriceEl) {
if (success && data && data.success && data.result) {
const { keyPrice, id } = data.result;
pyPriceEl.textContent = keyPrice ? `¥${keyPrice}` : '暂无';
pyPriceEl.classList.remove('loading', 'error');
// 更新跳转链接
const pyItem = pyPriceEl.closest('.thirdparty-item');
if (pyItem && id) {
pyItem.setAttribute('data-url', `https://steampy.com/cdkDetail?name=cn&gameId=${id}`);
pyItem.onclick = function() { window.open(this.getAttribute('data-url'), '_blank'); };
}
} else {
pyPriceEl.textContent = '未收录';
pyPriceEl.classList.remove('loading');
}
}
});
window.addEventListener('STEAMCICI_RESPONSE', function(e) {
console.log('✅ [网页] 收到油猴响应 (SteamCICI):', e.detail);
const { containerId, subId, success, data } = e.detail;
const container = document.getElementById(containerId);
if (!container) return;
// 清除兜底定时器（如果是双向绑定的话，通常只要有一个响应就说明油猴在工作）
// 这里不做清除，因为两个接口是独立的
const ciciPriceEl = container.querySelector('.cici-price');
if (ciciPriceEl) {
if (success && data && data.code === 200 && data.rows) {
const gameData = data.rows.find(item => String(item.gameId) === String(subId));
if (gameData && gameData.lastLowSellPrice !== null) {
ciciPriceEl.textContent = `¥${gameData.lastLowSellPrice}`;
ciciPriceEl.classList.remove('loading', 'error');
} else {
ciciPriceEl.textContent = '暂无';
ciciPriceEl.classList.remove('loading');
}
} else {
ciciPriceEl.textContent = '未收录';
ciciPriceEl.classList.remove('loading');
}
}
});
window.addEventListener('EPIC_PRICE_RESPONSE', function(e) {
console.log('✅ [网页] 收到油猴 Epic 价格响应:', e.detail);
const { containerId, gameName, success, results } = e.detail;
const container = document.getElementById(containerId);
if (!container) return;
if (fallbackTimers[containerId]) {
clearTimeout(fallbackTimers[containerId]);
delete fallbackTimers[containerId];
}
const statusEl = container.querySelector('.epic-query-status');
const gridEl = container.querySelector('.epic-price-grid');
if (!success || !results || Object.keys(results).length === 0) {
if (statusEl) {
statusEl.textContent = '未收录或请求失败';
statusEl.style.color = '#ff6b6b';
}
return;
}
// 寻找最匹配的游戏商品ID
let targetGameId = null;
const cnElements = results["CN"] || [];
if (cnElements.length > 0) {
targetGameId = cnElements[0].id;
} else {
for (const code in results) {
if (results[code].length > 0) {
targetGameId = results[code][0].id;
break;
}
}
}
if (!targetGameId) {
if (statusEl) {
statusEl.textContent = '未收录';
statusEl.style.color = '#ff6b6b';
}
if (gridEl) gridEl.innerHTML = '<div style="grid-column: span 2; text-align: center; color: #8f98a0; font-size: 10px;">Epic 商店未检索到此游戏</div>';
return;
}
const regionLabels = {
"CN": { name: "国区", code: "cn" },
"TR": { name: "土区", code: "tr" }
};
let html = '';
const codes = ["CN", "TR"];
codes.forEach(code => {
const region = regionLabels[code];
const regionElements = results[code] || [];
let matched = null;
for (const elem of regionElements) {
if (elem.id === targetGameId) {
matched = elem;
break;
}
}
const productSlug = matched ? (matched.productSlug || matched.urlSlug || '') : '';
const epicUrl = productSlug ? `https://store.epicgames.com/zh-CN/p/${productSlug}` : 'https://store.epicgames.com/zh-CN/';
const flagImg = `<img src="${getFlagUrl(region.code)}" style="width: 14px; height: 10px; border-radius: 1px; vertical-align: middle; margin-right: 4px; display: inline-block;">`;
if (matched && matched.price && matched.price.totalPrice) {
const priceInfo = matched.price.totalPrice;
const curr = priceInfo.currencyCode;
const divisor = curr === 'JPY' ? 1 : 100;
const orig = priceInfo.originalPrice / divisor;
const disc = priceInfo.discountPrice / divisor;
let cnyVal = disc;
if (curr !== 'CNY') {
const rate = (typeof EXCHANGE_RATES !== 'undefined' && EXCHANGE_RATES[curr]) || (window.EXCHANGE_RATES && window.EXCHANGE_RATES[curr]);
if (rate) {
cnyVal = disc * rate;
}
}
const discountPercent = priceInfo.originalPrice > priceInfo.discountPrice ? 
Math.round((1 - priceInfo.discountPrice / priceInfo.originalPrice) * 100) : 0;
html += `
<a href="${epicUrl}" target="_blank" class="epic-price-item" style="background: #101822; border: 1px solid #2a475e; padding: 4px; border-radius: 4px; text-align: center; display: flex; flex-direction: column; justify-content: space-between; text-decoration: none; cursor: pointer; color: inherit;"><div style="color: #8f98a0; font-size: 9px; display: flex; align-items: center; justify-content: center;">
${flagImg} <span>${region.name}</span></div><div style="color: #a4d007; font-weight: bold; font-size: 13px; margin: 2px 0;">
¥${cnyVal.toFixed(1)}
</div><div style="color: #56c0f4; font-size: 8px; font-weight: normal; transform: scale(0.9); white-space: nowrap;">
${curr} ${disc.toFixed(1)}${discountPercent > 0 ? `(-${discountPercent}%)` : ''}
</div></a>
`;
} else {
html += `
<a href="${epicUrl}" target="_blank" class="epic-price-item" style="background: #101822; border: 1px solid #2a475e; padding: 4px; border-radius: 4px; text-align: center; display: flex; flex-direction: column; justify-content: center; opacity: 0.5; text-decoration: none; cursor: pointer; color: inherit;"><div style="color: #8f98a0; font-size: 9px; display: flex; align-items: center; justify-content: center;">${flagImg} <span>${region.name}</span></div><div style="color: #8f98a0; font-size: 8px; margin-top: 4px;">暂无价格</div></a>
`;
}
});
if (statusEl) {
statusEl.textContent = '已更新';
statusEl.style.color = '#a4d007';
}
if (gridEl) {
gridEl.innerHTML = html;
}
});
// 非国区地区列表（与 Python CC_LIST 剥除国区后顺序一致）
const REGIONS_NON_CN = [
{code: 'ru', name: '俄罗斯'},
{code: 'kz', name: '哈萨克斯坦'},
{code: 'ua', name: '乌克兰'},
{code: 'pk', name: '南亚'},
{code: 'tr', name: '土耳其'},
{code: 'ar', name: '阿根廷'},
{code: 'az', name: '阿塞拜疆'},
{code: 'vn', name: '越南'},
{code: 'id', name: '印尼'},
{code: 'in', name: '印度'},
{code: 'br', name: '巴西'},
{code: 'cl', name: '智利'},
{code: 'jp', name: '日本'},
{code: 'hk', name: '中国香港'},
{code: 'ph', name: '菲律宾'}
];
// 全部地区列表（用于筛选菜单）
const REGIONS = [{code: 'cn', name: '中国'}, ...REGIONS_NON_CN];
// [V7.2] 地区简写映射
const REGION_ABBR_MAP = {
'中国': '国区',
'俄罗斯': '俄区',
'哈萨克斯坦': '哈区',
'乌克兰': '乌区',
'南亚': '南亚',
'土耳其': '土区',
'阿根廷': '阿区',
'阿塞拜疆': '阿塞',
'越南': '越区',
'印尼': '印尼',
'印度': '印区',
'巴西': '巴区',
'智利': '智区',
'日本': '日区',
'中国香港': '港区',
'菲律宾': '菲区'
};
// [V7.2] 计算特定地区差价
function getRegionDiff(game, regionIdx) {
if (regionIdx === -1 || game.cp === null) return 0;
const priceData = game.ap && game.ap[regionIdx];
if (!priceData || priceData === 0) return 0; // Locked
const regionCny = priceData[1];
if (regionCny === null) return 0;
return Math.max(0, game.cp - regionCny);
}
// 筛选状态
let currentRegionFilter = null;
let currentFilterMode = 'global'; // 'global'=全区最低, 'cheaper'=比国区低
let currentPopoverGameIdx = null;
// Steam 用户数据
// Steam 官方外币格式化字典 (前缀 / 后缀)
const STEAM_CURRENCY_SYMBOLS = {
'CNY': ['¥ ', ''], 'RUB': ['', ' pуб.'], 'KZT': ['', '₸'],
'UAH': ['', '₴'], 'USD': ['$', ''], 'VND': ['', '₫'],
'IDR': ['Rp ', ''], 'INR': ['₹ ', ''], 'BRL': ['R$ ', ''],
'CLP': ['CLP$ ', ''], 'JPY': ['¥ ', ''], 'HKD': ['HK$ ', ''],
'PHP': ['₱', '']
};
const userLibrary = {
owned: new Set(),
familyMap: new Map(),  // Key=AppID, Value=[拥有者昵称数组]
wishlist: new Set(),
familyWishlistMap: new Map(),  // Key=AppID, Value=[拥有者昵称数组]
ownedPackages: new Set()  // [V1.3] 主号拥有的 Package SubID (从 rgOwnedPackages 解析)
};
const syncBtn = document.getElementById('syncBtn');
const syncModalOverlay = document.getElementById('syncModalOverlay');
const syncJsonInput = document.getElementById('syncJsonInput');
// 隐私弹窗
const privacyModalOverlay = document.getElementById('privacyModalOverlay');
const privacyConfirmBtn = document.getElementById('privacyConfirmBtn');
let pendingMode = null;
let cooldownTimer = null;
// 筛选工具栏 DOM
const filterToolbar = document.getElementById('filterToolbar');
const filterRegionFlag = document.getElementById('filterRegionFlag');
const filterRegionName = document.getElementById('filterRegionName');
const filterModeGlobal = document.getElementById('filterModeGlobal');
const filterModeCheaper = document.getElementById('filterModeCheaper');
// ==================== URL 解压辅助函数 ====================
function getCoverUrl(game) {
// c 不存在或为空表示标准格式，否则为完整 URL
return game.c ? game.c : COVER_PREFIX + game.id + COVER_SUFFIX;
}
function getStoreUrl(game) {
return STORE_PREFIX + game.id;
}
function getLowestRegion(li) {
// li=-1 表示国区，否则为 REGIONS_NON_CN 索引
if (li === -1) return {code: 'cn', name: '中国'};
return REGIONS_NON_CN[li] || {code: 'cn', name: '中国'};
}
// ==================== 辅助函数 ====================
function escapeHtml(str) {
if (!str) return '';
return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatReviews(count) {
if (count >= 10000) return Math.floor(count / 10000) + '万+';
if (count >= 1000) return Math.floor(count / 1000) + 'k+';
return count.toString();
}
function showAccountTooltip(event, el) {
let tooltip = document.getElementById('accountTooltip');
if (!tooltip) {
tooltip = document.createElement('div');
tooltip.id = 'accountTooltip';
tooltip.className = 'custom-tooltip';
tooltip.style.cssText = `
display: none;
position: absolute;
z-index: 10000;
padding: 12px;
border-radius: 8px;
background: rgba(22, 25, 32, 0.85);
backdrop-filter: blur(12px);
border: 1px solid rgba(102, 192, 244, 0.3);
color: #fff;
box-shadow: 0 8px 32px rgba(0,0,0,0.5);
pointer-events: none;
min-width: 120px;
transition: opacity 0.2s;
`;
document.body.appendChild(tooltip);
}
const type = el.getAttribute('data-type');
const ownersRaw = el.getAttribute('data-owners');
let owners = [];
if (ownersRaw) {
try { owners = JSON.parse(ownersRaw); } catch(e) {}
}
let title = '';
let titleColor = '#66c0f4';
let borderColor = 'rgba(102, 192, 244, 0.3)';
if (type === 'owned') {
title = '归属账号';
titleColor = '#a4d007';
borderColor = 'rgba(164, 208, 7, 0.4)';
} else if (type === 'family') {
title = '家庭共享来源';
titleColor = '#b37feb';
borderColor = 'rgba(179, 127, 235, 0.4)';
} else if (type === 'wishlist') {
title = '愿望单所属';
titleColor = '#66c0f4';
borderColor = 'rgba(102, 192, 244, 0.4)';
} else if (type === 'cart') {
title = '购物车';
titleColor = '#ffd700';
borderColor = 'rgba(255, 215, 0, 0.4)';
} else {
title = '游戏归属';
}
tooltip.style.border = '1px solid ' + borderColor;
let html = '<div style="font-size: 12px; color: ' + titleColor + '; margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">' + title + '</div>';
html += '<div style="display: flex; flex-direction: column; gap: 6px;">';
if (owners.length === 0) owners.push('未知');
owners.forEach(name => {
let avatarUrl = '';
if (name === '我') {
avatarUrl = (friendCodes[0] && friendCodes[0].avatar) || '';
} else {
const fc = friendCodes.find(f => f.name === name);
if (fc && fc.avatar) avatarUrl = fc.avatar;
}
const imgHtml = avatarUrl 
? '<img src="' + avatarUrl + '" style="width: 24px; height: 24px; border-radius: 4px; object-fit: cover;">'
: '<div style="width: 24px; height: 24px; border-radius: 4px; background: #333; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #888;">?</div>';
html += '<div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">' +
imgHtml +
'<span style="white-space: nowrap;">' + escapeHtml(name) + '</span>' +
'</div>';
});
html += '</div>';
tooltip.innerHTML = html;
tooltip.style.display = 'block';
tooltip.style.opacity = '1';
const rect = el.getBoundingClientRect();
let leftPos = rect.left + window.scrollX;
if (leftPos + 150 > window.innerWidth) leftPos = window.innerWidth - 160;
tooltip.style.left = leftPos + 'px';
tooltip.style.top = (rect.bottom + window.scrollY + 6) + 'px';
}
function hideAccountTooltip() {
const tooltip = document.getElementById('accountTooltip');
if (tooltip) {
tooltip.style.display = 'none';
tooltip.style.opacity = '0';
}
}
function getRatingClass(rate) {
if (rate >= 80) return '';
if (rate >= 50) return 'medium';
return 'low';
}
function getFlagUrl(code) {
return `https://flagcdn.com/20x15/${code}.png`;
}
function isMobile() {
return window.innerWidth < 769;
}
function getRegionIndex(code) {
return (!code || code === 'cn' || code === 'locked') ? -1 : REGIONS_NON_CN.findIndex(r => r.code === code);
}
// ==================== 图片重载 ====================
function reloadImages() {
// [V1.1.1] 使用 .game-card img 同时覆盖普通卡片和捆绑包卡片
const images = document.querySelectorAll('.game-card img');
let reloadCount = 0;
const timestamp = Date.now();
images.forEach(img => {
// 检查是否加载失败
if (img.style.display === 'none' || img.naturalWidth === 0) {
const originalSrc = img.src.split('?')[0];
img.src = originalSrc + '?t=' + timestamp;
img.style.display = '';
reloadCount++;
}
});
alert(`已重载 ${reloadCount} 张图片`);
}
// ==================== Steam 数据同步 (模态框版) ====================
function openSyncModal() {
syncModalOverlay.classList.add('active');
syncJsonInput.value = '';
// 初始化自动同步开关状态
updateAutoSyncBtnUI(localStorage.getItem('auto_sync_userdata') === 'true');
syncJsonInput.focus();
}
function closeSyncModal() {
syncModalOverlay.classList.remove('active');
}
// [V1.1.2] 更新自动同步按钮 UI
function updateAutoSyncBtnUI(isActive) {
const btn = document.getElementById('autoSyncUserdataBtn');
if (!btn) return;
if (isActive) {
btn.innerHTML = '▶ 脚本自动同步 (运行中)';
btn.style.background = 'rgba(46, 204, 113, 0.2)';
btn.style.color = '#2ecc71';
btn.style.borderColor = 'rgba(46, 204, 113, 0.4)';
} else {
btn.innerHTML = '⏸ 脚本自动同步 (已关)';
btn.style.background = 'rgba(100, 100, 100, 0.3)';
btn.style.color = '#8f98a0';
btn.style.borderColor = 'rgba(150, 150, 150, 0.3)';
}
}
function getIsHideOwned() {
const el = document.getElementById('hideOwnedCheckPanel');
return el ? el.checked : false;
}
function getIsWishlistPriority() {
const el = document.getElementById('wishlistPriorityCheckPanel');
return el ? el.checked : false;
}
function getIsShowTop3Regions() {
const el = document.getElementById('top3CheckPanel');
return el ? el.checked : true;
}
// [V1.1.2] 开关 userdata 自动同步
function toggleAutoSyncUserdataBtn() {
const isCurrentlyActive = localStorage.getItem('auto_sync_userdata') === 'true';
const newState = !isCurrentlyActive;
localStorage.setItem('auto_sync_userdata', newState ? 'true' : 'false');
updateAutoSyncBtnUI(newState);
if (newState) {
showSyncToast('▶ 自动拉取 userdata 已开启');
window.dispatchEvent(new CustomEvent('AUTO_SYNC_USERDATA_REQUEST'));
} else {
showSyncToast('⏸ 自动拉取 userdata 已关闭');
}
}
// [V1.1.2] 更新好友列表指定账号的绑定地区
function updateFriendRegion(index, regionCode) {
if (friendCodes[index]) {
friendCodes[index].region = regionCode;
updateFriendCodesStore();
showSyncToast(`✅ 已将该账号地区偏好设为 ${REGION_ABBR_MAP[REGIONS.find(r=>r.code===regionCode)?.name] || regionCode}`);
}
}
// ==================== 高级筛选面板逻辑 ====================
// 绑定好评率输入框，限制输入范围为 0-100
function bindReviewInputs() {
const filterRateMin = document.getElementById('filterRateMin');
const filterRateMax = document.getElementById('filterRateMax');
if(!filterRateMin || !filterRateMax) return;
const clampVal = (el) => {
let val = parseInt(el.value);
if (el.value === '') return;
if (isNaN(val)) val = 0;
if (val > 100) val = 100;
if (val < 0) val = 0;
el.value = val;
};
filterRateMin.addEventListener('input', function() {
clampVal(this);
});
filterRateMax.addEventListener('input', function() {
clampVal(this);
});
}
function updateGiftFilterUI() {
const isChecked = document.getElementById('giftFilterCheckbox').checked;
const minInput = document.getElementById('diffMin');
const maxInput = document.getElementById('diffMax');
const typeSelect = document.getElementById('diffTypeSelect');
const typeSelectorBtn = document.getElementById('diffTypeSelectorBtn');
if (isChecked) {
// 自动切换为百分比并锁定
typeSelect.value = 'percent';
typeSelect.disabled = true;
typeSelect.style.opacity = '0.5';
typeSelect.style.cursor = 'not-allowed';
if (typeSelectorBtn) {
typeSelectorBtn.style.opacity = '0.5';
typeSelectorBtn.style.cursor = 'not-allowed';
typeSelectorBtn.style.pointerEvents = 'none'; // 禁用点击
document.getElementById('diffTypeSelectedName').textContent = '百分比';
const menu = document.getElementById('diffTypeMenu');
if (menu) {
menu.querySelectorAll('.filter-region-popup-item').forEach(item => {
if (item.getAttribute('data-value') === 'percent') {
item.classList.add('active');
} else {
item.classList.remove('active');
}
});
}
}
// 填写赠礼逻辑对应的隐式区间 0-15
minInput.value = '0';
maxInput.value = '15';
minInput.disabled = true;
maxInput.disabled = true;
minInput.style.opacity = '0.5';
maxInput.style.opacity = '0.5';
minInput.style.cursor = 'not-allowed';
maxInput.style.cursor = 'not-allowed';
updateDiffTypeUI();
applyFilters();
} else {
typeSelect.disabled = false;
typeSelect.style.opacity = '1';
typeSelect.style.cursor = 'pointer';
if (typeSelectorBtn) {
typeSelectorBtn.style.opacity = '1';
typeSelectorBtn.style.cursor = 'pointer';
typeSelectorBtn.style.pointerEvents = 'auto'; // 启用点击
}
minInput.disabled = false;
maxInput.disabled = false;
minInput.style.opacity = '1';
maxInput.style.opacity = '1';
minInput.style.cursor = 'text';
maxInput.style.cursor = 'text';
// 恢复默认
minInput.value = '';
maxInput.value = '';
updateDiffTypeUI();
applyFilters();
}
}
function updateDiffTypeUI() {
const diffType = document.getElementById('diffTypeSelect').value;
const diffLabel = document.getElementById('diffCurrencyLabel');
const minInput = document.getElementById('diffMin');
const maxInput = document.getElementById('diffMax');
if (diffType === 'percent') {
diffLabel.textContent = '%';
minInput.step = '1';
maxInput.step = '1';
minInput.placeholder = '最低 %';
maxInput.placeholder = '最高 %';
} else {
diffLabel.textContent = 'CNY';
minInput.step = '0.01';
maxInput.step = '0.01';
minInput.placeholder = '最低差价';
maxInput.placeholder = '最高差价';
}
}
// 区域及货币
const CURRENCY_MAP = {
'cn': 'CNY', 'ru': 'RUB', 'kz': 'KZT', 'ua': 'UAH', 'pk': 'USD',
'tr': 'USD', 'ar': 'USD', 'az': 'USD', 'vn': 'VND', 'id': 'IDR',
'in': 'INR', 'br': 'BRL', 'cl': 'CLP', 'jp': 'JPY', 'hk': 'HKD', 'ph': 'PHP'
};
function populateFilterRegionPopup() {
const popup = document.getElementById('filterRegionPopup');
popup.innerHTML = '';
REGIONS.forEach(reg => {
const el = document.createElement('div');
el.className = 'filter-region-popup-item';
if (reg.code === 'cn') el.classList.add('active'); // 默认国区
el.innerHTML = `<img src="https://flagcdn.com/20x15/${reg.code}.png" style="width:16px; height:12px; border-radius:2px;"><span>${REGION_ABBR_MAP[reg.name]||reg.name}</span>`;
el.onclick = (e) => {
e.stopPropagation();
selectFilterRegion(reg.code, REGION_ABBR_MAP[reg.name]||reg.name, el);
};
popup.appendChild(el);
});
}
function toggleFilterRegionSelector(e) {
e.stopPropagation();
const popup = document.getElementById('filterRegionPopup');
popup.classList.toggle('show');
}
function toggleDiffTypeDropdown(e) {
e.stopPropagation();
const menu = document.getElementById('diffTypeMenu');
const isShown = menu.style.display === 'grid';
menu.style.display = isShown ? 'none' : 'grid';
}
function selectDiffType(value, name, e) {
if (e) e.stopPropagation();
const selectEl = document.getElementById('diffTypeSelect');
if (selectEl.value !== value) {
selectEl.value = value;
selectEl.dispatchEvent(new Event('change'));
}
document.getElementById('diffTypeSelectedName').textContent = name;
const menu = document.getElementById('diffTypeMenu');
menu.querySelectorAll('.filter-region-popup-item').forEach(item => {
if (item.getAttribute('data-value') === value) {
item.classList.add('active');
} else {
item.classList.remove('active');
}
});
menu.style.display = 'none';
}
document.addEventListener('click', (e) => {
const popup = document.getElementById('filterRegionPopup');
const selector = document.querySelector('.filter-region-selector');
if (popup && popup.classList.contains('show') && !selector.contains(e.target)) {
popup.classList.remove('show');
}
const diffMenu = document.getElementById('diffTypeMenu');
const diffSelector = document.getElementById('diffTypeSelectorBtn');
if (diffMenu && diffMenu.style.display === 'grid' && diffSelector && !diffSelector.contains(e.target)) {
diffMenu.style.display = 'none';
}
});
function selectFilterRegion(code, nameStr, el) {
document.getElementById('filterPanelRegionFlag').src = `https://flagcdn.com/20x15/${code}.png`;
document.getElementById('filterPanelRegionFlag').setAttribute('data-code', code);
document.getElementById('filterPanelRegionName').textContent = nameStr;
document.getElementById('filterCurrencyLabel').textContent = CURRENCY_MAP[code] || 'USD';
document.querySelectorAll('.filter-region-popup-item').forEach(i => i.classList.remove('active'));
if(el) el.classList.add('active');
document.getElementById('filterRegionPopup').classList.remove('show');
}
function toggleFilterPanel() {
const overlay = document.getElementById('filterPanelOverlay');
if (!overlay.classList.contains('show')) {
const tol = document.getElementById('toleranceInput');
if (tol && tol.value.trim() === '') tol.value = '0';
}
overlay.classList.toggle('show');
}
function resetAdvancedFilters() {
const elTop3 = document.getElementById('top3CheckPanel');
if (elTop3) elTop3.checked = true;
const elHide = document.getElementById('hideOwnedCheckPanel');
if (elHide) elHide.checked = false;
const elWish = document.getElementById('wishlistPriorityCheckPanel');
if (elWish) elWish.checked = false;
const elStrict = document.getElementById('strictRegionCheck');
if (elStrict) elStrict.checked = false;
const elTolerance = document.getElementById('toleranceInput');
if (elTolerance) elTolerance.value = '0';
const elHlNew = document.getElementById('hlNewCheck');
if (elHlNew) elHlNew.checked = false;
const elHlEq = document.getElementById('hlEqualCheck');
if (elHlEq) elHlEq.checked = false;
const elHlNon = document.getElementById('hlNonCheck');
if (elHlNon) elHlNon.checked = false;
const elMin = document.getElementById('filterPriceMin');
if (elMin) elMin.value = '';
const elMax = document.getElementById('filterPriceMax');
if (elMax) elMax.value = '';
const elRateMin = document.getElementById('filterRateMin');
if (elRateMin) elRateMin.value = '';
const elRateMax = document.getElementById('filterRateMax');
if (elRateMax) elRateMax.value = '';
const elRcMin = document.getElementById('filterRcMin');
if (elRcMin) elRcMin.value = '';
const elRcMax = document.getElementById('filterRcMax');
if (elRcMax) elRcMax.value = '';
const diffMinEl = document.getElementById('diffMin');
if (diffMinEl) diffMinEl.value = '';
const diffMaxEl = document.getElementById('diffMax');
if (diffMaxEl) diffMaxEl.value = '';
// 重置复选框
const giftFilterCheckbox = document.getElementById('giftFilterCheckbox');
if (giftFilterCheckbox) {
giftFilterCheckbox.checked = false;
}
const diffTypeSelect = document.getElementById('diffTypeSelect');
if (diffTypeSelect) {
diffTypeSelect.disabled = false;
diffTypeSelect.style.opacity = '1';
diffTypeSelect.value = 'absolute';
if (typeof updateDiffTypeUI === 'function') updateDiffTypeUI();
}
// 重置自定义UI显示
const diffTypeSelectedName = document.getElementById('diffTypeSelectedName');
if (diffTypeSelectedName) {
diffTypeSelectedName.textContent = '绝对值';
}
const diffTypeMenu = document.getElementById('diffTypeMenu');
if (diffTypeMenu) {
diffTypeMenu.querySelectorAll('.filter-region-popup-item').forEach(item => {
if (item.getAttribute('data-value') === 'absolute') {
item.classList.add('active');
} else {
item.classList.remove('active');
}
});
}
const typeSelectorBtn = document.getElementById('diffTypeSelectorBtn');
if (typeSelectorBtn) {
typeSelectorBtn.style.opacity = '1';
typeSelectorBtn.style.cursor = 'pointer';
typeSelectorBtn.style.pointerEvents = 'auto';
}
selectFilterRegion('cn', '国区', document.querySelector('.filter-region-popup-item')); // 默认恢复国选
refreshDisplay();
}
function applyAdvancedFilters() {
toggleFilterPanel(); // 仅关闭UI组件
refreshDisplay();
}
document.addEventListener('DOMContentLoaded', () => {
populateFilterRegionPopup();
// 注意原本 DOMContentLoaded 末尾的动作
const flagEl = document.getElementById('filterPanelRegionFlag');
if (flagEl) flagEl.setAttribute('data-code', 'cn');
bindReviewInputs();
});
// [V7.1] 删除遗留的原绑定旧开关逻辑
function toggleTop3(checked) {
console.log("旧版开关已弃用");
}
function toggleHideOwned(checked) {
console.log("旧版开关已弃用");
}
function toggleWishlistPriority(checked) {
console.log("旧版开关已弃用");
}
// ==================== 隐私弹窗逻辑 ====================
function showPrivacyModal(mode) {
const jsonText = syncJsonInput.value.trim();
if (!jsonText) {
alert('请先粘贴 JSON 数据');
return;
}
pendingMode = mode;
privacyModalOverlay.classList.add('active');
startCooldown();
}
function closePrivacyModal() {
privacyModalOverlay.classList.remove('active');
if (cooldownTimer) {
clearInterval(cooldownTimer);
cooldownTimer = null;
}
privacyConfirmBtn.disabled = true;
privacyConfirmBtn.classList.remove('ready');
privacyConfirmBtn.textContent = '确认导入 (3s)';
}
function startCooldown() {
let remaining = 3;
privacyConfirmBtn.disabled = true;
privacyConfirmBtn.classList.remove('ready');
privacyConfirmBtn.textContent = `确认导入 (${remaining}s)`;
privacyConfirmBtn.onclick = null;
cooldownTimer = setInterval(() => {
remaining--;
if (remaining > 0) {
privacyConfirmBtn.textContent = `确认导入 (${remaining}s)`;
} else {
clearInterval(cooldownTimer);
cooldownTimer = null;
privacyConfirmBtn.disabled = false;
privacyConfirmBtn.classList.add('ready');
privacyConfirmBtn.textContent = '确认导入';
privacyConfirmBtn.onclick = executeSync;
}
}, 1000);
}
function executeSync() {
const jsonText = syncJsonInput.value.trim();
const result = parseSteamData(jsonText, pendingMode);
closePrivacyModal();
closeSyncModal();
syncBtn.classList.add('synced');
if (pendingMode === 'self') {
alert(`同步成功（自己）！
🟢 已拥有: ${result.owned} 款
🔵 愿望单: ${result.wishlist} 款`);
} else {
alert(`同步成功（家庭）！🟣 家庭共享: ${result.family} 款`);
}
resetAndRender();
// [V1.3] 数据解析完毕后刷新捆绑包撞库状态
if (bundleMode) {
renderBundleGrid();
}
refreshBundleOwnership();
}
// ==================== 正则解析核心 ====================
function parseSteamData(text, mode) {
const result = { owned: 0, family: 0, wishlist: 0 };
// [V7.1] 优先级校验：如果 API 已获取数据，跳过 JSON 的 Own 解析
const skipOwned = (mode === 'self' && hasApiData);
if (skipOwned) {
console.log('ℹ️ [优先级] API 数据已存在，跳过 JSON 库存解析');
}
// 检测是否包含关键词
const hasOwnedKey = text.includes('rgOwnedApps');
const hasWishlistKey = text.includes('rgWishlist');
const hasKeys = hasOwnedKey || hasWishlistKey;
if (hasKeys) {
// 场景 A：包含 Key 的片段
if (mode === 'self') {
// 提取 rgOwnedApps 的数字
if (!skipOwned) {
const ownedMatch = text.match(/"rgOwnedApps"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
if (ownedMatch) {
const numbers = ownedMatch[1].match(/\d+/g) || [];
userLibrary.owned.clear();
numbers.forEach(n => userLibrary.owned.add(parseInt(n)));
result.owned = userLibrary.owned.size;
}
}
// [V1.3] 提取 rgOwnedPackages 的数字 (用于撞库推演)
const pkgMatch = text.match(/"rgOwnedPackages"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
if (pkgMatch) {
const pkgNumbers = pkgMatch[1].match(/\d+/g) || [];
userLibrary.ownedPackages.clear();
pkgNumbers.forEach(n => userLibrary.ownedPackages.add(parseInt(n, 10)));
console.log(`[主号] 更新拥有的 Package 数量: ${userLibrary.ownedPackages.size}`);
}
const wishlistMatch = text.match(/"rgWishlist"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
if (wishlistMatch) {
const numbers = wishlistMatch[1].match(/\d+/g) || [];
userLibrary.wishlist.clear();
numbers.forEach(n => userLibrary.wishlist.add(parseInt(n, 10)));
}
} else {
// 家庭模式：追加到现有家庭库（支持多人合并）
const ownedMatch = text.match(/"rgOwnedApps"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
if (ownedMatch) {
const numbers = ownedMatch[1].match(/\d+/g) || [];
numbers.forEach(n => {
const appId = parseInt(n);
if (!userLibrary.familyMap.has(appId)) {
userLibrary.familyMap.set(appId, ['手动导入']);
}
});
result.family = userLibrary.familyMap.size;
}
}
} else {
// 场景 B：纯数字列表
const allNumbers = text.match(/\d+/g) || [];
if (mode === 'self') {
if (!skipOwned) {
userLibrary.owned.clear();
allNumbers.forEach(n => userLibrary.owned.add(parseInt(n)));
result.owned = userLibrary.owned.size;
}
} else {
allNumbers.forEach(n => {
const appId = parseInt(n);
if (!userLibrary.familyMap.has(appId)) {
userLibrary.familyMap.set(appId, ['手动导入']);
}
});
result.family = userLibrary.familyMap.size;
}
}
return result;
}
// ==================== 前三低价区开关（已被弃用，逻辑直接走UI组件） ====================
// 计算比国区便宜的前三个地区
function getTop3Cheaper(game) {
if (!game.ap) return [];
const cheaperRegions = [];
for (let i = 0; i < REGIONS_NON_CN.length; i++) {
const priceData = game.ap[i];
if (priceData === 0) continue; // 锁区
const [display, cny] = priceData;
if (cny !== null && (game.cp === null || cny < game.cp)) {
cheaperRegions.push({
code: REGIONS_NON_CN[i].code,
name: REGIONS_NON_CN[i].name,
display: display,
cny: cny
});
}
}
// 按价格升序排序，取前3
cheaperRegions.sort((a, b) => a.cny - b.cny);
return cheaperRegions.slice(0, 3);
}
// 生成前三低价区价格行 HTML
function generateTop3PriceRows(game, lowestRegion, lowestPriceStr) {
const top3 = getTop3Cheaper(game);
if (top3.length === 0) {
// 国区就是最低价，显示原逻辑
const lowestFlag = `<img class="flag-icon" src="${getFlagUrl(lowestRegion.code)}" alt="${escapeHtml(lowestRegion.name)}" onerror="this.style.display='none'">`;
return `
<div class="price-row"><span class="price-label">${lowestFlag}${escapeHtml(lowestRegion.name)} 最低</span><span class="price-value lowest">${lowestPriceStr}</span></div>
`;
}
// 显示前三低价区
let html = '';
for (let i = 0; i < top3.length; i++) {
const r = top3[i];
const flag = `<img class="flag-icon" src="${getFlagUrl(r.code)}" alt="${escapeHtml(r.name)}" onerror="this.style.display='none'">`;
const medal = `<img src="${MEDAL_ICONS[i]}" style="width: 16px; height: 16px; vertical-align: middle; margin-left: 4px;" alt="medal">`;
html += `
<div class="price-row top3-row"><span class="price-label">${flag}${escapeHtml(r.name)}${medal}</span><span class="price-value lowest">¥${r.cny.toFixed(2)}</span></div>
`;
}
return html;
}
// ==================== 双模式筛选 ====================
function showFilterToolbar(regionCode, regionName) {
filterRegionFlag.src = getFlagUrl(regionCode);
filterRegionFlag.style.display = '';
filterRegionName.textContent = regionName;
filterToolbar.classList.add('active');
document.body.classList.add('toolbar-active');
// 国区只显示全区最低
if (regionCode === 'cn') {
filterModeCheaper.style.display = 'none';
const fhd = document.getElementById('filterModeHighDiff');
if (fhd) fhd.style.display = 'none';
} else {
filterModeCheaper.style.display = '';
const fhd = document.getElementById('filterModeHighDiff');
if (fhd) fhd.style.display = '';
}
}
function hideFilterToolbar() {
filterToolbar.classList.remove('active');
document.body.classList.remove('toolbar-active');
}
function setFilterMode(mode) {
currentFilterMode = mode;
filterModeGlobal.classList.toggle('active', mode === 'global');
filterModeCheaper.classList.toggle('active', mode === 'cheaper');
const fhd = document.getElementById('filterModeHighDiff');
if (fhd) fhd.classList.toggle('active', mode === 'highdiff');
refreshDisplay();
}
function clearAllFilters() {
currentRegionFilter = null;
currentFilterMode = 'global';
currentSortType = 'default';
// searchInput.value = ''; // 禁止清空搜索
hideFilterToolbar();
regionDropdownBtn.classList.remove('active');
regionDropdownBtn.innerHTML = '📉 地区低价 ▼';
document.querySelectorAll('.region-option').forEach(opt => opt.classList.remove('active'));
// 重置"默认推荐"下拉菜单 UI
const sortDropdownBtn = document.getElementById('sortDropdownBtn');
if (sortDropdownBtn) {
sortDropdownBtn.textContent = '⭐ 默认推荐 ▼';
}
const sortMenu = document.getElementById('sortMenu');
if (sortMenu) {
sortMenu.querySelectorAll('.region-option').forEach(opt => opt.classList.remove('active'));
const defaultOption = sortMenu.querySelector('[data-sort="default"]');
if (defaultOption) {
defaultOption.classList.add('active');
}
}
refreshDisplay();
}
function applyRegionFilter(sourceData) {
const strictRegionCheckEl = document.getElementById('strictRegionCheck');
const isToleranceEnabled = strictRegionCheckEl ? strictRegionCheckEl.checked : false;
const toleranceInputEl = document.getElementById('toleranceInput');
const userTolerance = toleranceInputEl ? Math.max(0, parseFloat(toleranceInputEl.value) || 0) : 0;
// 未开启自定义容错时，全区低价(global)默认宽容度设为 5
const tolerance = isToleranceEnabled ? (userTolerance === 0 ? 0.01 : userTolerance) : 5;
if (!currentRegionFilter) return;
// 如果没传数据，说明是外部直接调用(不应该发生，但防守一下)，用 refreshDisplay 重定向
if (!sourceData) {
console.warn('applyRegionFilter called without data, redirecting to refreshDisplay');
refreshDisplay();
return;
}
const code = currentRegionFilter;
if (code === 'locked') {
let lockedGroup = sourceData.filter(g => !g.cp || g.cp === -1 || g.cp === "");
lockedGroup.sort((a, b) => {
const priceA = a.lp !== null ? a.lp : 999999;
const priceB = b.lp !== null ? b.lp : 999999;
return priceA - priceB;
});
displayData = lockedGroup;
resetAndRender();
return;
}
const regionIdx = REGIONS_NON_CN.findIndex(r => r.code === code);
let priorityGroup = []; // 关注和愿望单极致优先
let group1 = []; // 全球最低
let group2 = []; // 比国区便宜 (非最低)
const isWishlistPriorityActive = getIsWishlistPriority();
const checkPriority = (g) => {
if (!isWishlistPriorityActive) return false;
if (favorites.has(g.id)) return true;
if (userLibrary.wishlist.has(g.id) || userLibrary.familyWishlistMap.has(g.id)) return true;
return false;
};
// 1. 分组逻辑 (基于传入的 sourceData)
if (code === 'cn') {
for (const g of sourceData) {
if (g.li === -1) {
if (checkPriority(g)) priorityGroup.push(g);
else group1.push(g);
}
}
} else if (regionIdx !== -1) {
// [V1.6] 统一遍历逻辑，按"是否有折扣"分组
// Group 1: 有折扣 (g.d > 0)
// Group 2: 无折扣
// [黄油模式] 预计算港区索引，用于 cheaper 模式基准切换
const hkIdx = REGIONS_NON_CN.findIndex(r => r.code === 'hk');
for (const g of sourceData) {
if (!g.ap || !g.ap[regionIdx]) continue;
const priceData = g.ap[regionIdx];
if (priceData === 0) continue; // 锁区
const regionCny = priceData[1];
if (regionCny === null) continue;
// [黄油模式] global 分类：解除对国区价格的强依赖
if (adultModeActive && currentFilterMode === 'global') {
// 只要该区是全区最低即可，不管国区是否锁区
if (g.lp !== null && regionCny <= g.lp + tolerance) {
const hasDiscount = parseDiscount(g.d) > 0;
if (checkPriority(g)) priorityGroup.push(g);
else if (hasDiscount) group1.push(g);
else group2.push(g);
}
continue;
}
// 确定比价基准：黄油模式用港区，普通模式用国区
let basePrice = g.cp; // 默认国区
if (adultModeActive && currentFilterMode === 'cheaper') {
// 黄油模式 cheaper 子分类: 基准改为港区
const hkData = (hkIdx !== -1 && g.ap[hkIdx] && g.ap[hkIdx] !== 0) ? g.ap[hkIdx] : null;
if (hkData) {
basePrice = hkData[1]; // 港区 CNY 价格
} else {
// 港区也锁区 -> 兜底放行
const hasDiscount = parseDiscount(g.d) > 0;
if (checkPriority(g)) priorityGroup.push(g);
else if (hasDiscount) group1.push(g);
else group2.push(g);
continue;
}
}
if (basePrice === null) continue;
// 必须比基准价便宜
if (regionCny < basePrice - 1) {
const hasDiscount = parseDiscount(g.d) > 0;
if (currentFilterMode === 'global') {
// global模式: 必须也是全区最低
if (g.lp !== null && regionCny <= g.lp + tolerance) {
if (checkPriority(g)) priorityGroup.push(g);
else if (hasDiscount) group1.push(g);
else group2.push(g);
}
} else if (currentFilterMode === 'cheaper') {
// cheaper模式: 只要便宜就行
if (checkPriority(g)) priorityGroup.push(g);
else if (hasDiscount) group1.push(g);
else group2.push(g);
} else if (currentFilterMode === 'highdiff') {
// highdiff模式: 未打折 且 非黄油 且 差价>=50
const meetsTolerance = isToleranceEnabled ? (g.lp !== null && regionCny <= g.lp + tolerance) : true;
if (!hasDiscount && !g.is_adult && (basePrice - regionCny >= 50) && meetsTolerance) {
if (checkPriority(g)) priorityGroup.push(g);
else group1.push(g);
}
}
}
}
}
// 2. 组内排序 (Complex Sort with Priority)
const compareFn = (a, b) => {
const aFav = favorites.has(a.id) ? 1 : 0;
const bFav = favorites.has(b.id) ? 1 : 0;
if (bFav !== aFav) return bFav - aFav;
if (getIsWishlistPriority()) {
const aWish = userLibrary.wishlist.has(a.id) || userLibrary.familyWishlistMap.has(a.id) ? 1 : 0;
const bWish = userLibrary.wishlist.has(b.id) || userLibrary.familyWishlistMap.has(b.id) ? 1 : 0;
if (bWish !== aWish) return bWish - aWish;
}
// [V7.2] 动态排序依据: 黄油模式使用默认复杂排序，普通模式按地区差价
if (adultModeActive) {
return compareComplex(a, b);
}
if (regionIdx !== -1) {
// [V7.3] 引入连锁排序逻辑：非默认排序时，保留对应的排序指标
if (currentSortType === 'rate') {
const tierA = Math.floor(a.rc / 1000);
const tierB = Math.floor(b.rc / 1000);
if (tierA !== tierB) return tierB - tierA;
return (b.r || 0) - (a.r || 0);
} else if (currentSortType === 'discount') {
const discA = parseDiscount(a.d);
const discB = parseDiscount(b.d);
if (discB !== discA) return discB - discA;
return a._sortIndex - b._sortIndex;
} else if (currentSortType === 'new2026') {
return (newGamesMap[b.id] || "").localeCompare(newGamesMap[a.id] || "");
} else if (currentSortType === 'top100') {
return (a._top100Rank || 999) - (b._top100Rank || 999);
} else if (currentSortType === 'diff') {
const tierA = Math.floor((a.df || 0) / 5);
const tierB = Math.floor((b.df || 0) / 5);
if (tierB !== tierA) return tierB - tierA;
return a._sortIndex - b._sortIndex;
}
const diffA = getRegionDiff(a, regionIdx);
const diffB = getRegionDiff(b, regionIdx);
// 优先显示省钱多的
if (diffA !== diffB) return diffB - diffA;
// 其次按好评率
return (b.r || 0) - (a.r || 0);
}
return compareComplex(a, b);
};
priorityGroup.sort(compareFn);
group1.sort(compareFn);
group2.sort(compareFn);
// 系列不可分割区块重组 (高差价潜力模式下，不进行系列合并，全部拆开放)
if (currentFilterMode !== 'highdiff') {
priorityGroup = applySeriesBlocks(priorityGroup);
group1 = applySeriesBlocks(group1);
group2 = applySeriesBlocks(group2);
}
// 3. 合并 (Group 1 Top)
displayData = [...priorityGroup, ...group1, ...group2];
resetAndRender();
}
// ==================== 菜单切换 ====================
function toggleMenu() {
navControls.classList.toggle('open');
}
// ==================== 生成价格列表 HTML (仅地区价格) ====================
function generatePriceListHTML(game, itemClass) {
const { cp, li, ap } = game;
let html = '';
// 国区
const isCnLowest = li === -1;
html += `
<div class="${itemClass}${isCnLowest ? ' lowest-region' : ''} cn-region" onclick="showGiftingPopup(${game.id}, 'cn', event, false)"><img class="flag" src="${getFlagUrl('cn')}" alt="中国" onerror="this.style.display='none'"><span class="name">中国</span><div class="prices"><span class="cny">¥${cp !== null ? cp.toFixed(2) : '锁区'}</span></div></div>
`;
// 其他区域 (位置数组)
if (ap) {
for (let idx = 0; idx < ap.length; idx++) {
const priceData = ap[idx];
const region = REGIONS_NON_CN[idx];
if (!region) continue;
const isLowest = (li >= 0 && idx === li);
const cls = isLowest ? `${itemClass} lowest-region` : itemClass;
if (priceData === 0) {
// 锁区
html += `
<div class="${cls}" onclick="showGiftingPopup(${game.id}, '${region.code}', event, false)"><img class="flag" src="${getFlagUrl(region.code)}" alt="${escapeHtml(region.name)}" onerror="this.style.display='none'"><span class="name">${escapeHtml(region.name)}</span><span class="locked">锁区</span></div>
`;
} else {
const [orig, cny] = priceData;
let priceClass = 'same';
if (cp !== null && cny !== null) {
if (cny < cp - 1) priceClass = 'cheaper';
else if (cny > cp + 1) priceClass = 'expensive';
}
html += `
<div class="${cls}" onclick="showGiftingPopup(${game.id}, '${region.code}', event, false)"><img class="flag" src="${getFlagUrl(region.code)}" alt="${escapeHtml(region.name)}" onerror="this.style.display='none'"><span class="name">${escapeHtml(region.name)}</span><div class="prices"><span class="orig">${escapeHtml(orig)}</span><span class="cny ${priceClass}">¥${cny.toFixed(2)}</span></div></div>
`;
}
}
}
return html;
}
// ==================== 生成第三方 CDK 区域 HTML (独立函数) ====================
function generateThirdPartyHTML(game, suffix = 'default', layout = 'horizontal') {
// 仅当有 sid (国区 SubID) 时生成
if (!game.sid) return '';
const containerId = `thirdparty-${game.id}-${suffix}`;
const layoutClass = layout === 'vertical' ? ' vertical-layout' : '';
return `
<div class="thirdparty-section" id="${containerId}"><div class="thirdparty-title">🏪 第三方平台 (CDK)</div><div class="thirdparty-grid${layoutClass}"><a class="thirdparty-item" href="https://steampy.com/" target="_blank"><span class="icon py"></span><span class="name">SteamPY CDK</span><span class="price loading py-price">查询中...</span></a><a class="thirdparty-item" href="https://steamcici.com/index" target="_blank"><span class="icon cici"></span><span class="name">SteamCICI</span><span class="price loading cici-price">查询中...</span></a></div></div>
`;
}
// ==================== 生成 Epic 地区价格区域 HTML (独立函数) ====================
function generateEpicPriceHTML(game, suffix) {
const containerId = `epic-price-${game.id}-${suffix}`;
return `
<div class="epic-price-section" id="${containerId}" style="margin-top: 10px; border-top: 1px dashed #2a475e; padding-top: 8px;"><div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"><span style="color: #66c0f4; font-size: 11px; font-weight: bold; display: flex; align-items: center; gap: 4px;"><span class="icon epic-icon" style="width:12px; height:12px; display:inline-block; vertical-align:middle; background-size:contain; background-image: var(--epic-icon);"></span> Epic 地区比价
</span><span class="epic-query-status" style="font-size: 10px; color: #8f98a0;">查询中...</span></div><div class="epic-price-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; font-size: 10px;"><!-- 由油猴脚本动态填充 --></div></div>
`;
}
// ==================== 生成全局价格窗口 (列表+柱状图) ====================
function generateGlobalPriceWidget(game, suffix) {
// 生成核心列表
const listHTML = generatePriceListHTML(game, suffix === 'mobile' ? 'detail-item' : 'popover-item');
const cdkListHTML = generateThirdPartyHTML(game, suffix + '-list', 'horizontal');
const epicHTML = generateEpicPriceHTML(game, suffix);
// 生成图表内容
const chartHTML = generateBarChartHTML(game);
const cdkChartHTML = generateThirdPartyHTML(game, suffix + '-chart', 'vertical');
return `
<div class="gpw-container" id="gpw-${game.id}-${suffix}"><div class="gpw-header"><span class="gpw-title">全区价格</span><div class="gpw-tabs"><div class="gpw-tab-btn active" onclick="switchGPW('${game.id}', '${suffix}', 'list', event)" title="列表视图"><svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm0 5h2v2H4zm0 5h2v2H4zm4-10h12v2H8zm0 5h12v2H8zm0 5h12v2H8z"/></svg></div><div class="gpw-tab-btn" onclick="switchGPW('${game.id}', '${suffix}', 'chart', event)" title="柱状图视图"><svg viewBox="0 0 24 24"><path d="M4 20h16v2H4zM6 16h3v4H6zm5-6h3v10h-3zm5-4h3v14h-3z"/></svg></div></div></div><div class="gpw-content"><!-- 列表视图 --><div class="gpw-view active" id="gpw-list-${game.id}-${suffix}">
${suffix === 'mobile' ? 
`<div class="details-grid">${listHTML}</div>${cdkListHTML}${epicHTML}` : 
`<div class="popover-grid">${listHTML}</div><div class="popover-footer">${cdkListHTML}${epicHTML}</div>`
}
</div><!-- 图表视图 --><div class="gpw-view" id="gpw-chart-${game.id}-${suffix}"><div class="gpw-chart-layout"><div class="bc-chart-area">
${chartHTML}
</div><div class="bc-cdk-area">
${cdkChartHTML}
</div></div></div></div></div>
`;
}
function switchGPW(gameId, suffix, viewType, event) {
if (event) {
event.stopPropagation();
event.preventDefault();
}
const containerId = `gpw-${gameId}-${suffix}`;
const container = document.getElementById(containerId);
if (!container) return;
// Update Tab Buttons
const tabs = container.querySelectorAll('.gpw-tab-btn');
tabs.forEach(tab => tab.classList.remove('active'));
if (event && event.currentTarget) {
event.currentTarget.classList.add('active');
} else {
const targetTabIdx = viewType === 'list' ? 0 : 1;
if (tabs[targetTabIdx]) tabs[targetTabIdx].classList.add('active');
}
// Update Views
const viewList = document.getElementById(`gpw-list-${gameId}-${suffix}`);
const viewChart = document.getElementById(`gpw-chart-${gameId}-${suffix}`);
if (viewType === 'list') {
if (viewChart) viewChart.classList.remove('active');
if (viewList) viewList.classList.add('active');
// Set fixed width for PC popover when returning to list
if (suffix === 'popover') {
const popoverEl = document.getElementById('popover');
if (popoverEl) {
popoverEl.style.width = '320px';
// Keep popup above viewport bottom bounds when resizing
popoverEl.style.transform = '';
}
}
} else {
if (viewList) viewList.classList.remove('active');
if (viewChart) viewChart.classList.add('active');
// Expand PC popover width for chart
if (suffix === 'popover') {
const popoverEl = document.getElementById('popover');
if (popoverEl) {
popoverEl.style.width = '480px';
}
}
}
// Re-fetch CDK for the active view to ensure it triggers correctly
if (typeof displayData !== 'undefined') {
const game = displayData.find(g => String(g.id) === String(gameId));
if (game) {
const epicContainerId = `epic-price-${game.id}-${suffix}`;
fetchEpicRegionalPrices(game.n, epicContainerId);
if (game.sid) {
const cdkContainerId = `thirdparty-${game.id}-${suffix}-${viewType}`;
fetchThirdPartyPrices(game.id, game.sid, cdkContainerId);
}
}
}
}
function generateBarChartHTML(game) {
const { cp, ap } = game;
// Collect valid regions
let regionsData = [];
// Add CN
regionsData.push({
code: 'cn',
name: '中国',
cny: cp,
locked: cp === null || cp === -1 || cp === "",
orig: (cp !== null && cp !== -1 && cp !== "") ? `¥${cp.toFixed(2)}` : '锁区'
});
// Add others
if (ap) {
for (let idx = 0; idx < ap.length; idx++) {
const priceData = ap[idx];
const region = REGIONS_NON_CN[idx];
if (!region) continue;
if (priceData === 0) {
regionsData.push({
code: region.code,
name: region.name,
cny: null,
locked: true,
orig: '锁区'
});
} else {
regionsData.push({
code: region.code,
name: region.name,
cny: priceData[1],
locked: false,
orig: priceData[0]
});
}
}
}
// Sort: Valid regions by CNY ascending, then locked regions at the end
regionsData.sort((a, b) => {
if (a.locked && !b.locked) return 1;
if (!a.locked && b.locked) return -1;
if (a.locked && b.locked) return 0;
return a.cny - b.cny;
});
// Find max CNY for scaling
let maxCny = 0;
regionsData.forEach(r => {
if (!r.locked && r.cny > maxCny) maxCny = r.cny;
});
if (maxCny === 0) maxCny = 1; // Prevent division by zero
// Calculate Baseline Y Position if CN is not locked
let cnPrice = null;
let cnRatio = 0;
const cnData = regionsData.find(r => r.code === 'cn');
if (cnData && !cnData.locked) {
cnPrice = cnData.cny;
cnRatio = Math.max((cnPrice / maxCny) * 100, 5); // Match exact bar calculation to ensure pixel-perfect alignment
// For perfectly matching the top edge of the cn bar:
// If cnRatio > 100 it gets visually clipped anyway, but base ratio logic must match exactly.
}
let html = '<div style="display: flex; gap: 8px; height: 100%; align-items: flex-end; position: relative; padding-bottom: 20px; width: max-content;">';
// Draw baseline if applicable
if (cnPrice !== null && cnPrice > 0) {
html += `
<div class="bc-baseline"><span class="bc-baseline-label">国区 ¥${cnPrice.toFixed(2)}</span></div>
`;
}
// Interactive mouse tracking logic for tooltip
const mouseMoveJS = "const tip = this.querySelector('.bc-tooltip'); if(tip) { tip.style.left = (event.clientX + 15) + 'px'; tip.style.top = (event.clientY + 15) + 'px'; }";
// Find top 3 cheapest region codes
const validRegions = regionsData.filter(r => !r.locked && r.cny > 0).sort((a,b) => a.cny - b.cny);
const top3Codes = validRegions.slice(0, 3).map(r => r.code);
const medalsClassStr = ['medal-gold', 'medal-silver', 'medal-copper'];
// Draw bars
regionsData.forEach(r => {
let barHtml = '';
const flagUrl = getFlagUrl(r.code);
let medalHtml = '';
const rankIdx = top3Codes.indexOf(r.code);
if (rankIdx === 0) {
medalHtml = `<img class="bc-medal" src="assets/images/inline-image-3.png">`;
} else if (rankIdx === 1) {
medalHtml = `<img class="bc-medal" src="assets/images/inline-image-4.png">`;
} else if (rankIdx === 2) {
medalHtml = `<img class="bc-medal" src="assets/images/inline-image-5.png">`;
}
if (r.locked) {
barHtml = `
<div class="bc-bar-group locked" onmousemove="${mouseMoveJS}"><div class="bc-tooltip">${escapeHtml(r.name)}<br>锁区</div><div class="bc-bar-value">锁区</div><div class="bc-bar"></div><div class="bc-bar-label"><img class="flag" src="${flagUrl}" onerror="this.style.display='none'"><span class="name">${escapeHtml(r.name)}</span></div></div>
`;
} else {
const ratio = Math.max((r.cny / maxCny) * 100, 5); // min 5% height
let barClass = 'bc-bar-green';
let diffHtml = '';
if (cnPrice !== null) {
if (r.cny > cnPrice) {
barClass = 'bc-bar-red';
}
// Calculate percentage difference
const diffPct = ((r.cny - cnPrice) / cnPrice) * 100;
if (diffPct > 0.005) {
diffHtml = ` <span style="color:#ff4d4d; font-weight:bold;">+${diffPct.toFixed(2)}%</span>`;
} else if (diffPct < -0.005) {
diffHtml = ` <span style="color:#2ecc71; font-weight:bold;">${diffPct.toFixed(2)}%</span>`;
} else {
diffHtml = ` <span style="color:#8f98a0;">0.00%</span>`;
}
}
barHtml = `
<div class="bc-bar-group" onmousemove="${mouseMoveJS}"><div class="bc-tooltip">
${escapeHtml(r.name)}<br>
原始: ${escapeHtml(r.orig)}<br>
折合: ¥${r.cny.toFixed(2)}${diffHtml}
</div><div class="bc-bar-value">¥${r.cny.toFixed(0)}</div><div class="bc-bar ${barClass}" style="height: ${ratio}%"></div><div class="bc-bar-label"><img class="flag" src="${flagUrl}" onerror="this.style.display='none'"><span class="name">${escapeHtml(r.name)}</span>
${medalHtml}
</div></div>
`;
}
html += barHtml;
});
html += '</div>';
return html;
}
// ==================== 卡片渲染 (压缩数据格式) ====================
function createCardHTML(game, index) {
const { i, id, n, d, r, rc, cp, lp, li, df, hl, fs, tc } = game;
const isAdult = game.is_adult === true;
const regionIdx = getRegionIndex(currentRegionFilter);
let displayPrice = '';
let priceCny = null;
let lowestRegionCode = 'cn';
// 决定价格展示（跟随当前地区选择）
if (regionIdx !== -1) {
const pd = game.ap && game.ap[regionIdx];
if (pd && pd !== 0) {
displayPrice = pd[0]; // [修复Bug] pd[0] 为显示价格字符串
priceCny = pd[1];
lowestRegionCode = currentRegionFilter;
}
} else {
displayPrice = game.nfp || game.p;
priceCny = cp;
if(li !== undefined && li !== -1) {
lowestRegionCode = REGIONS_NON_CN[li]?.code || 'cn';
}
}
// 是否拥有/家庭共享/愿望单
const isOwned = userLibrary.owned.has(id);
const familyOwners = userLibrary.familyMap.get(id) || [];
const isFamily = familyOwners.length > 0;
const isWishlist = userLibrary.wishlist.has(id);
const familyWishlistOwners = userLibrary.familyWishlistMap.get(id) || [];
const isFamilyWishlist = familyWishlistOwners.length > 0;
const isFavorite = favorites.has(id);
// 基础显示逻辑
let displayStyle = '';
const hideOwned = getIsHideOwned();
if (hideOwned && (isOwned || isFamily)) {
displayStyle = 'display: none;';
}
// 生成状态徽章 (左上角)
let statusBadgeHTML = '';
const isInCart = typeof cartSet !== 'undefined' && cartSet.has(id);
let cardClass = 'game-card';
if (isOwned) {
cardClass = 'game-card owned';
const ownersStr = escapeHtml(JSON.stringify(['我']));
statusBadgeHTML = `<div class="status-badge owned" data-owners="${ownersStr}" data-type="owned" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">已拥有<span style="font-size: 9px; color: rgba(27,40,56,0.65); margin-left: 2px; font-weight: normal;">?</span></div>`;
} else if (isInCart) {
cardClass = 'game-card in-cart';
const ownersStr = escapeHtml(JSON.stringify(['我']));
statusBadgeHTML = `<div class="status-badge cart-badge-label" data-owners="${ownersStr}" data-type="cart" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">🛒购物车中</div>`;
} else if (isFamily) {
cardClass = 'game-card family';
const ownersStr = escapeHtml(JSON.stringify(familyOwners));
statusBadgeHTML = `<div class="status-badge family" data-owners="${ownersStr}" data-type="family" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">家庭共享<span style="font-size: 9px; color: rgba(255,255,255,0.75); margin-left: 2px; font-weight: normal;">?</span></div>`;
} else if (isWishlist || isFamilyWishlist) {
cardClass = 'game-card wishlist';
const allOwners = [];
if (isWishlist) allOwners.push('我');
familyWishlistOwners.forEach(n => allOwners.push(n));
const ownersStr = escapeHtml(JSON.stringify(allOwners));
const displayText = allOwners.length === 1
? '愿望单'
: '愿望单 +' + (allOwners.length - 1);
statusBadgeHTML = `<div class="status-badge wishlist" data-owners="${ownersStr}" data-type="wishlist" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">${escapeHtml(displayText)}<span style="font-size: 9px; color: rgba(27,40,56,0.65); margin-left: 2px; font-weight: normal;">?</span></div>`;
}
if (isFavorite) cardClass += ' favorite';
const starBtnClass = isFavorite ? 'star-btn active' : 'star-btn';
// 史低打标 UI
let discountBadgeHTML = '';
if (d && d !== '0') {
if (hl === 1) {
discountBadgeHTML = `<div class="discount-badges-container"><span class="discount-badge hl-new">${escapeHtml(d)}</span><span class="hl-tag">新史低</span></div>`;
} else if (hl === 2) {
discountBadgeHTML = `<div class="discount-badges-container"><span class="discount-badge hl-even">${escapeHtml(d)}</span></div>`;
} else if (hl === 3) {
discountBadgeHTML = `<div class="discount-badges-container"><span class="discount-badge hl-none">${escapeHtml(d)}</span></div>`;
} else {
discountBadgeHTML = `<div class="discount-badges-container"><span class="discount-badge">${escapeHtml(d)}</span></div>`;
}
}
// EPIC 与 HB 慈善包徽章堆叠
const epicDate = game.epic_date;
const epicBadgeHTML = epicDate ? `<div class="epic-badge"><span class="epic-icon"></span>EPIC ${epicDate} 送过</div>` : '';
const hbData = game.hb;
const hbBadgeHTML = hbData ? `<div class="hb-badge"><span class="hb-icon"></span>${escapeHtml(hbData)}</div>` : '';
const bottomLeftBadges = (epicBadgeHTML || hbBadgeHTML) ? `<div class="bottom-left-badges">${epicBadgeHTML}${hbBadgeHTML}</div>` : '';
// 成人游戏 data 属性
const adultAttr = isAdult ? ' data-adult="true"' : '';
// 动态拼接 URL
const coverUrl = getCoverUrl(game);
const storeUrl = getStoreUrl(game);
const lowestRegion = getLowestRegion(li);
const rateStr = r > 0 ? r.toFixed(1) + '%' : 'N/A';
const ratingClass = getRatingClass(r);
const reviewsStr = formatReviews(rc);
const cnPriceStr = cp !== null ? '¥' + cp.toFixed(2) : '暂无';
const lowestPriceStr = lp !== null ? '¥' + lp.toFixed(2) : '暂无';
let diffBadge = '';
// [V7.2] 动态差价标签
if (currentRegionFilter && currentRegionFilter !== 'cn') {
const regionCode = currentRegionFilter;
const regionIdx = REGIONS_NON_CN.findIndex(reg => reg.code === regionCode);
const dynDiff = getRegionDiff(game, regionIdx);
if (dynDiff > 0) {
const rName = REGIONS.find(reg => reg.code === regionCode)?.name || regionCode;
const abbrName = REGION_ABBR_MAP[rName] || rName;
const flagUrl = getFlagUrl(regionCode);
// 格式: 🇹🇷 <span class="align-text-up">土区省 ¥15</span>
diffBadge = `<span class="diff-badge positive"><img src="${flagUrl}" class="mini-flag"><span class="align-text-up">${abbrName}省 ¥${dynDiff.toFixed(0)}</span></span>`;
} else {
diffBadge = `<span class="diff-badge">无特定差价</span>`;
}
} else {
// 原有逻辑 (全局最低差价)
diffBadge = df > 0 ? 
`<span class="diff-badge positive"><span class="align-text-up">省¥${df.toFixed(0)}</span></span>` :
`<span class="diff-badge"><span class="align-text-up">无差价</span></span>`;
}
const lowestFlag = `<img class="flag-icon" src="${getFlagUrl(lowestRegion.code)}" alt="${escapeHtml(lowestRegion.name)}" onerror="this.style.display='none'">`;
// 移除不再需要的旧版单独列表调用
return `
<div class="${cardClass}" data-idx="${i}"${adultAttr} style="${displayStyle}"><div class="cover-wrapper">
${(() => {
if (currentSortType === 'top100' && game._top100Rank) {
return `<div class="top100-rank-badge">#${game._top100Rank}</div>`;
}
return '';
})()}
${statusBadgeHTML}
<span class="cover-placeholder">🎮</span><img class="cover" src="${escapeHtml(coverUrl)}" alt="${escapeHtml(n)}" loading="lazy" onerror="this.style.display='none';this.previousElementSibling.style.display='block';">
${discountBadgeHTML}
${bottomLeftBadges}
<span class="appid-badge">${id}</span></div><div class="info"><div class="title-row">
${isOwned ? `
<div class="title-interactive-wrap" style="cursor: not-allowed;" title="已拥有的游戏无法加入购物车"><h3 class="game-title">${escapeHtml(n)}</h3><div class="cart-hover-overlay" style="color: #e74c3c;">已拥有不可加购</div></div>` : `
<div class="title-interactive-wrap" onclick="toggleCartItem(event, ${id})"><h3 class="game-title">${escapeHtml(n)}</h3><div class="cart-hover-overlay">${isInCart ? '移除购物车' : '加入购物车'}</div></div>`}
<div class="title-tags">
${game.xgp ? `<span class="tag xgp" title="${game.xgp}"><span class="tag-icon"></span></span>` : ''}
${fs === 1 ? '<span class="tag family-share" title="支持家庭共享"><span class="tag-icon"></span></span>' : ''}
${tc === 1 ? '<span class="tag trading-card" title="包含 Steam 集换式卡牌"><span class="tag-icon"></span></span>' : ''}
</div><button class="${starBtnClass}" onclick="toggleFavorite(event, ${id})" title="关注/取消关注"><span class="star-empty">☆</span><span class="star-filled">★</span></button></div><div class="tags-row"><span class="tag rating ${ratingClass}">好评${rateStr}</span><span class="tag reviews">${reviewsStr}评测</span><a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="steam-btn"><span class="steam-icon"></span><span>STEAM商店</span></a></div><div class="price-section"><div class="price-row"><span class="price-label"><img class="flag-icon" src="${getFlagUrl('cn')}" alt="中国" onerror="this.style.display='none'">国区
</span><span class="price-value cn">${cnPriceStr}</span></div>
${getIsShowTop3Regions() ? generateTop3PriceRows(game, lowestRegion, lowestPriceStr) : `
<div class="price-row"><span class="price-label">${lowestFlag}${escapeHtml(lowestRegion.name)}</span><span class="price-value lowest">${lowestPriceStr}</span></div>
`}
<div class="price-row"><span class="price-label">差价</span><div class="price-diff">${diffBadge}</div></div></div><button class="details-btn" onclick="toggleDetails(event, ${i})"><span class="arrow">▼</span> 全区价格
</button><div class="details-container" id="details-${i}" data-appid="${id}" data-subid="${game.sid || ''}">
${generateGlobalPriceWidget(game, 'mobile')}
</div></div></div>
`;
}
// ==================== 切换详情 (手机端手风琴 / PC端浮窗 Toggle) ====================
function toggleDetails(event, idx) {
event.stopPropagation();
const game = displayData.find(g => g.i === idx);
if (!game) return;
if (isMobile()) {
// 手机端: 手风琴展开
const container = document.getElementById('details-' + idx);
const btn = event.currentTarget;
const isOpening = !container.classList.contains('open');
container.classList.toggle('open');
btn.classList.toggle('open');
// [重构] 展开时触发 CDK 与 Epic 价格请求
if (isOpening) {
const epicContainerId = `epic-price-${game.id}-mobile`;
fetchEpicRegionalPrices(game.n, epicContainerId);
if (game.sid) {
const containerId = `thirdparty-${game.id}-mobile-list`;
fetchThirdPartyPrices(game.id, game.sid, containerId);
}
}
} else {
// PC端: Toggle 浮窗
if (popover.classList.contains('open') && currentPopoverGameIdx === idx) {
// 当前已打开且是同一游戏，关闭
closePopover();
} else {
// 打开/切换到新游戏
const card = event.currentTarget.closest('.game-card');
showPopover(game, card, idx);
}
}
}
// ==================== PC端浮窗 ====================
const popoverFooter = document.getElementById('popoverFooter');
function showPopover(game, card, idx) {
const { n, c } = game;
currentPopoverGameIdx = idx;
popoverCover.src = c || '';
popoverTitle.textContent = n;
// [重构] 分离填充：采用全局价格窗口整体替换
let gpwWrap = document.getElementById('popover-gpw-wrap');
if (!gpwWrap) {
gpwWrap = document.createElement('div');
gpwWrap.id = 'popover-gpw-wrap';
// 隐藏独立老结构
if (popoverGrid) popoverGrid.style.display = 'none';
if (popoverFooter) popoverFooter.style.display = 'none';
// 将新组件插入到原本 popoverGrid 同级
if (popoverGrid && popoverGrid.parentNode) {
popoverGrid.parentNode.appendChild(gpwWrap);
}
}
gpwWrap.innerHTML = generateGlobalPriceWidget(game, 'popover');
// 重置宽度，以防之前被图表撑开
popover.style.width = '320px';
// 计算位置
const rect = card.getBoundingClientRect();
const popoverWidth = 320;
const gap = 10;
let left, top;
// 检查右侧空间
if (rect.right + gap + popoverWidth < window.innerWidth) {
left = rect.right + gap;
} else {
left = rect.left - popoverWidth - gap;
}
if (left < 10) left = 10;
// 使用 scrollY 实现 absolute 定位（弹窗随卡片滚动）
top = rect.top + window.scrollY;
const maxTop = window.scrollY + window.innerHeight - 400;
if (top > maxTop) top = maxTop;
if (top < window.scrollY + 10) top = window.scrollY + 10;
popover.style.left = left + 'px';
popover.style.top = top + 'px';
popover.classList.add('open');
// [V7.3] Bundle Popup Logic (只取第一个有关联的捆绑包展示)
const bids = GAME_TO_BUNDLES[game.id] || [];
if (bids.length > 0) {
const targetBid = bids[0];
const bundle = bundleByBid[targetBid];
if (bundle) {
showAttachedBundlePopup(bundle, popover);
} else {
closeAttachedBundlePopup();
}
} else {
closeAttachedBundlePopup();
}
// [重构] 弹窗显示后立即请求 CDK 与 Epic 价格
const epicContainerId = `epic-price-${game.id}-popover`;
fetchEpicRegionalPrices(game.n, epicContainerId);
if (game.sid) {
const containerId = `thirdparty-${game.id}-popover-list`;
fetchThirdPartyPrices(game.id, game.sid, containerId);
}
}
// ==================== [V7.3] 附带捆绑包弹窗逻辑 ====================
const attachedBundlePopup = document.getElementById('attachedBundlePopup');
const attachedBundleCover = document.getElementById('attachedBundleCover');
const attachedBundleName = document.getElementById('attachedBundleName');
const attachedBundlePrice = document.getElementById('attachedBundlePrice');
let currentAttachedBundle = null;
function showAttachedBundlePopup(bundle, mainPopover) {
currentAttachedBundle = bundle;
attachedBundleCover.src = bundle.img || '';
attachedBundleCover.style.display = bundle.img ? 'block' : 'none';
attachedBundleName.textContent = bundle.n;
const lowestCode = (bundle.lc === 'BD') ? 'bd' : bundle.lc;
const lowestName = BUNDLE_REGION_NAMES[bundle.lc] || bundle.lc;
const lowestPriceStr = bundle.lv !== null ? '¥' + bundle.lv.toFixed(2) : '暂无';
attachedBundlePrice.innerHTML = `<img src="${getFlagUrl(lowestCode)}" style="width: 16px; height: 12px; vertical-align: middle; border-radius: 2px; margin-right: 4px;"> ${escapeHtml(lowestName)} 最低 <span style="float:right;">${lowestPriceStr}</span>`;
attachedBundlePopup.style.display = 'block';
// Boundary Check 延迟到下一帧，以获取真实尺寸
requestAnimationFrame(() => updateAttachedBundlePosition());
}
function updateAttachedBundlePosition() {
if (!currentAttachedBundle || attachedBundlePopup.style.display === 'none') return;
const mainPopover = document.getElementById('popover');
if (!mainPopover || !mainPopover.classList.contains('open')) return;
const mainRect = mainPopover.getBoundingClientRect();
const gap = 10;
const attachRect = attachedBundlePopup.getBoundingClientRect();
let left, top;
// 优先放右侧
if (mainRect.right + gap + attachRect.width <= window.innerWidth) {
left = mainRect.right + gap;
top = mainRect.top + window.scrollY; // 与主弹窗顶部对齐
} else {
// 右侧放不下，尝试放左侧
if (mainRect.left - gap - attachRect.width >= 0) {
left = mainRect.left - gap - attachRect.width;
top = mainRect.top + window.scrollY;
} else {
// 左右都放不下，放主弹窗下方
left = mainRect.left;
top = mainRect.bottom + window.scrollY + gap;
}
}
// 垂直/水平极限边界修正
if (top + attachRect.height > window.innerHeight + window.scrollY) {
top = window.innerHeight + window.scrollY - attachRect.height - gap;
}
if (left < gap) left = gap;
if (top < window.scrollY + gap) top = window.scrollY + gap;
attachedBundlePopup.style.left = left + 'px';
attachedBundlePopup.style.top = top + 'px';
}
// 监听主弹窗与捆绑包弹窗的物理尺寸变化，实现完美联动对齐
if (window.ResizeObserver) {
const ro = new ResizeObserver(() => {
if (typeof updateAttachedBundlePosition === 'function') {
updateAttachedBundlePosition();
}
});
// 等待 DOM 加载完成后挂载观察者
document.addEventListener('DOMContentLoaded', () => {
const popoverEl = document.getElementById('popover');
const attachPopupEl = document.getElementById('attachedBundlePopup');
if (popoverEl) ro.observe(popoverEl);
if (attachPopupEl) ro.observe(attachPopupEl);
});
}
function closeAttachedBundlePopup() {
if (attachedBundlePopup) attachedBundlePopup.style.display = 'none';
}
function jumpToAttachedBundle() {
if (!currentAttachedBundle) return;
const targetBid = currentAttachedBundle.bid;
closePopover();
closeAttachedBundlePopup();
if (!bundleMode) {
toggleBundleMode();
}
// 确保渲染完成再定位展开
requestAnimationFrame(() => {
setTimeout(() => {
const targetCard = document.querySelector(`.game-card[data-bidx] .appid-badge`);
let targetContainer = null;
document.querySelectorAll('.game-card').forEach(card => {
const badge = card.querySelector('.appid-badge');
if (badge && badge.textContent.trim() === String(targetBid)) {
targetContainer = card;
}
});
if (targetContainer) {
targetContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
setTimeout(() => {
const btn = targetContainer.querySelector('.details-btn');
if (btn) {
const evt = { stopPropagation: () => {}, preventDefault: () => {}, currentTarget: btn };
toggleBundleDetails(evt, targetBid);
}
}, 500);
}
}, 100);
});
}
function closePopover() {
popover.classList.remove('open');
currentPopoverGameIdx = null;
closeAttachedBundlePopup();
if (typeof closeBundleCalculator === 'function') closeBundleCalculator();
const giftingPopup = document.getElementById('giftingPopup');
if (giftingPopup) giftingPopup.style.display = 'none';
}
// 关闭弹窗的全局事件
document.addEventListener('click', (e) => {
// [Fix] 遇到计算器及关联窗口内部点击，直接阻断关闭主弹窗的冒泡
const path = e.composedPath();
const isInsidePopup = path.some(el => 
el.classList && (
el.classList.contains('bundle-calc-popup') || 
el.classList.contains('agr-detail-popup') || 
el.classList.contains('attached-bundle-popup') ||
el.classList.contains('gifting-popup')
)
);
if (isInsidePopup) {
return;
}
if (!popover.contains(e.target) && !e.target.closest('.details-btn')) {
closePopover();
}
if (!bundlePopover.contains(e.target) && !e.target.closest('.details-btn')) {
closeBundlePopover();
}
const giftingPopup = document.getElementById('giftingPopup');
if (giftingPopup && !giftingPopup.contains(e.target) && !e.target.closest('.detail-item') && !e.target.closest('.popover-item')) {
giftingPopup.style.display = 'none';
}
});
// ESC 关闭
document.addEventListener('keydown', (e) => {
if (e.key === 'Escape') {
closePopover();
closeBundlePopover();
const giftingPopup = document.getElementById('giftingPopup');
if (giftingPopup) giftingPopup.style.display = 'none';
}
});
// ==================== 批量渲染 ====================
function renderBatch() {
if (isLoading || renderedCount >= displayData.length) {
loader.classList.add('hidden');
return;
}
isLoading = true;
loader.classList.remove('hidden');
const fragment = document.createDocumentFragment();
const end = Math.min(renderedCount + BATCH_SIZE, displayData.length);
const tempDiv = document.createElement('div');
let html = '';
for (let i = renderedCount; i < end; i++) {
html += createCardHTML(displayData[i]);
}
tempDiv.innerHTML = html;
while (tempDiv.firstChild) {
fragment.appendChild(tempDiv.firstChild);
}
cardGrid.appendChild(fragment);
renderedCount = end;
isLoading = false;
updateStats();
if (renderedCount >= displayData.length) {
loader.classList.add('hidden');
}
}
function resetAndRender() {
cardGrid.innerHTML = '';
renderedCount = 0;
closePopover();
renderBatch();
}
function updateStats() {
const keyword = searchInput.value.trim();
if (currentRegionFilter) {
const regionName = REGIONS.find(r => r.code === currentRegionFilter)?.name || currentRegionFilter;
let modeText = '';
if (currentFilterMode === 'global') modeText = '全区最低';
else if (currentFilterMode === 'highdiff') modeText = '潜力大差价';
else modeText = adultModeActive ? '比港区低' : '比国区低';
stats.textContent = `${regionName} ${modeText}: ${displayData.length}款`;
} else if (keyword) {
stats.textContent = `${displayData.length}/${rawGameData.length}`;
} else {
stats.textContent = `共${rawGameData.length}款`;
}
}
// ==================== 搜索 ====================
// 3层加密函数
function encryptKey(key) {
try {
const encoded = encodeURIComponent(key);
const b64 = btoa(encoded);
return b64.split('').reverse().join('');
} catch (e) {
return '';
}
}
searchInput.addEventListener('input', function() {
clearTimeout(searchDebounceTimer);
searchDebounceTimer = setTimeout(() => {
refreshDisplay();
}, 200);
});
// ==================== 排序 ====================
function parseDiscount(d) {
// 解析折扣字符串："-50%" -> 50, "免费" -> 100
if (!d) return 0;
if (d === '免费') return 100;
const match = d.match(/-?(\d+)%?/);
return match ? parseInt(match[1]) : 0;
}
function getBaseData() {
// 获取基础数据（成人模式或普通模式）
let data = [];
// [V6.2] 黄油特权：关注的成人游戏无需密码显示
if (adultModeActive) {
data = rawGameData.filter(g => g.is_adult === true);
} else {
data = rawGameData.filter(g => {
// 非成人游戏显示
if (g.is_adult !== true) return true;
// 成人游戏但在关注列表中，显示（黄油特权）
if (favorites.has(g.id)) return true;
return false;
});
}
// [V7.1] 过滤已拥有和家庭共享
if (getIsHideOwned()) {
data = data.filter(g => {
const id = g.id;
// 过滤主账号已拥有
if (userLibrary.owned.has(id)) return false;
// 过滤家庭共享库
if (userLibrary.familyMap.has(id)) return false;
return true;
});
}
return data;
}
// ==================== 排序函数 ====================
function setSort(type) {
currentSortType = type;
// 如果选择的是默认推荐，则强制退出地区模式，回到全局默认
if (type === 'default') {
clearRegionFilter();
}
refreshDisplay();
if (isMobile()) {
navControls.classList.remove('open');
}
}
// 保留对特殊按钮（如 bundle/新游戏等）的点击事件绑定
document.querySelectorAll('.sort-btn').forEach(btn => {
// 跳过捆绑包按钮，因为它有自己独立的 toggleBundleMode 逻辑
if (btn.dataset.sort === 'bundle') return;
btn.addEventListener('click', function() {
const sortType = this.dataset.sort;
document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
this.classList.add('active');
currentSortType = sortType;
// 如果选择的是默认推荐，则强制退出地区模式，回到全局默认
if (sortType === 'default') {
clearRegionFilter();
}
refreshDisplay();
if (isMobile()) {
navControls.classList.remove('open');
}
});
});
// ==================== 地区下拉菜单 ====================
const regionDropdown = document.getElementById('regionDropdown');
const regionMenu = document.getElementById('regionMenu');
const regionDropdownBtn = regionDropdown.querySelector('.region-dropdown-btn');
function initRegionMenu() {
let html = `<div class="region-option" data-code="" onclick="selectRegion('')"><span class="name">🔄 全部显示</span></div>`;
for (const {code, name} of REGIONS) {
html += `<div class="region-option" data-code="${code}" onclick="selectRegion('${code}')"><img class="flag" src="${getFlagUrl(code)}" alt="${name}" onerror="this.style.display='none'"><span class="name">${name}</span></div>`;
}
html += `<div class="region-option" data-code="locked" onclick="selectRegion('locked')"><span class="name">🔒 锁国区游戏</span></div>`;
regionMenu.innerHTML = html;
}
function toggleRegionDropdown(event) {
event.stopPropagation();
regionMenu.classList.toggle('open');
}
function closeRegionDropdown() {
regionMenu.classList.remove('open');
}
function clearRegionFilter() {
currentRegionFilter = null;
regionDropdownBtn.classList.remove('active');
regionDropdownBtn.innerHTML = '📉 地区低价 ▼';
document.querySelectorAll('.region-option').forEach(opt => opt.classList.remove('active'));
hideFilterToolbar();
}
function selectRegion(code) {
closeRegionDropdown();
// 移除：清除排序按钮激活状态，以保持连锁排序的 UI 显示
// document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
if (!code) {
// 全部显示
clearAllFilters();
} else if (code === 'locked') {
currentRegionFilter = code;
currentFilterMode = 'global'; // Hide toolbar
regionDropdownBtn.classList.add('active');
regionDropdownBtn.innerHTML = `📉 锁国区游戏 ▼`;
document.querySelectorAll('.region-option').forEach(opt => {
opt.classList.toggle('active', opt.dataset.code === 'locked');
});
// 重置"默认推荐"下拉菜单 UI
const sortDropdownBtn = document.getElementById('sortDropdownBtn');
if (sortDropdownBtn) {
sortDropdownBtn.textContent = '⭐ 默认推荐 ▼';
}
const sortMenu = document.getElementById('sortMenu');
if (sortMenu) {
sortMenu.querySelectorAll('.region-option').forEach(opt => opt.classList.remove('active'));
const defaultOption = sortMenu.querySelector('[data-sort="default"]');
if (defaultOption) {
defaultOption.classList.add('active');
}
}
hideFilterToolbar();
refreshDisplay();
} else {
currentRegionFilter = code;
// currentSortType = 'default'; // 移除强制重置底层主排序状态，保持连锁
if (code === 'cn') {
currentFilterMode = 'global';
}
const regionName = REGIONS.find(r => r.code === code)?.name || code;
regionDropdownBtn.classList.add('active');
regionDropdownBtn.innerHTML = `📉 ${regionName} ▼`;
document.querySelectorAll('.region-option').forEach(opt => {
opt.classList.toggle('active', opt.dataset.code === code);
});
// 移除"默认推荐"下拉菜单 UI 的重置，保持当前排序按钮高亮状态
// 显示筛选工具栏
showFilterToolbar(code, regionName);
// UI 同步：确保界面按钮高亮与底层状态完全一致
document.getElementById('filterModeGlobal').classList.toggle('active', currentFilterMode === 'global');
document.getElementById('filterModeCheaper').classList.toggle('active', currentFilterMode === 'cheaper');
const fhd = document.getElementById('filterModeHighDiff');
if (fhd) fhd.classList.toggle('active', currentFilterMode === 'highdiff');
// 应用筛选
refreshDisplay();
}
if (isMobile()) {
navControls.classList.remove('open');
}
}
// 点击空白处关闭下拉菜单
document.addEventListener('click', (e) => {
if (!regionDropdown.contains(e.target)) {
closeRegionDropdown();
}
// 新增这一行：
if (typeof closeSortDropdown === 'function' && document.getElementById('sortDropdown') && !document.getElementById('sortDropdown').contains(e.target)) {
closeSortDropdown();
}
});
// ==================== 排序下拉菜单 ====================
function toggleSortDropdown(event) {
event.stopPropagation();
const menu = document.getElementById('sortMenu');
// 关闭其他可能打开的菜单
if (typeof closeRegionDropdown === 'function') closeRegionDropdown();
if (menu) menu.classList.toggle('open');
}
function closeSortDropdown() {
const menu = document.getElementById('sortMenu');
if (menu) menu.classList.remove('open');
}
function selectSort(type, name) {
closeSortDropdown();
// 更新按钮显示的文字
const btn = document.getElementById('sortDropdownBtn');
if (btn) {
btn.innerHTML = `${name} ▼`;
}
// 切换子选项的高亮状态
document.querySelectorAll('#sortMenu .region-option').forEach(opt => {
opt.classList.toggle('active', opt.dataset.sort === type);
});
// 调用原有的核心排序逻辑
setSort(type);
}
// ==================== 无限滚动 ====================
let scrollDebounceTimer = null;
window.addEventListener('scroll', function() {
if (scrollDebounceTimer) return;
scrollDebounceTimer = setTimeout(() => {
scrollDebounceTimer = null;
const scrollTop = window.scrollY;
const windowHeight = window.innerHeight;
const docHeight = document.documentElement.scrollHeight;
if (scrollTop + windowHeight >= docHeight - 300) {
renderBatch();
}
}, 50);
});
// ==================== [V7.1] API 与好友码管理 ====================
let friendCodes = [];
let apiKeyExists = false;
let storedApiKey = '';
let hasApiData = false; // 是否通过 API 获取到了拥有游戏数据
// Toast 通知函数
function showSyncToast(msg, duration) {
duration = duration || 3000;
let toast = document.getElementById('syncToast');
if (!toast) {
toast = document.createElement('div');
toast.id = 'syncToast';
toast.className = 'sync-toast';
document.body.appendChild(toast);
}
toast.textContent = msg;
toast.classList.add('show');
clearTimeout(toast._timer);
toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}
// API Key 保存
function saveApiKey() {
const input = document.getElementById('apikeyInput');
const val = input.value.trim();
const statusEl = document.getElementById('apikeyStatus');
if (!/^[A-Z0-9]{32}$/.test(val)) {
input.classList.remove('valid');
input.classList.add('invalid');
statusEl.textContent = '❌ 格式不正确 (需32位大写字母和数字)';
statusEl.className = 'apikey-status disconnected';
return;
}
input.classList.remove('invalid');
input.classList.add('valid');
storedApiKey = val;
apiKeyExists = true;
window.dispatchEvent(new CustomEvent('STEAM_DATA_UPDATE', {
detail: { type: 'apiKey', data: val }
}));
statusEl.textContent = '✅ Key 已保存';
statusEl.className = 'apikey-status connected';
showSyncToast('✅ API Key 已保存');
}
// 监听 API Key 无效事件
window.addEventListener('API_KEY_INVALID', function(e) {
const statusEl = document.getElementById('apikeyStatus');
if (statusEl) {
statusEl.textContent = '❌ Key 无效或无权限，请重新配置';
statusEl.className = 'apikey-status disconnected';
}
showSyncToast('❌ API Key 无效，请检查', 5000);
});
// 监听油猴初始化数据
window.addEventListener('STEAM_DATA_INIT', function(e) {
const data = e.detail;
console.log('📦 [网页] 收到初始化数据:', data);
apiKeyExists = data.hasApiKey;
storedApiKey = data.apiKey || '';
// 更新 API Key UI
const statusEl = document.getElementById('apikeyStatus');
const input = document.getElementById('apikeyInput');
if (apiKeyExists && statusEl) {
statusEl.textContent = '✅ 已配置 (来自油猴存储)';
statusEl.className = 'apikey-status connected';
if (input) input.value = storedApiKey;
}
// 恢复登录用户
if (data.loggedInUser && data.loggedInUser.steamid) {
const sid = data.loggedInUser.steamid;
const sname = data.loggedInUser.account_name || '主账号';
// 确保 loggedInUser 存在且在 friendCodes 数组中，如果存在则移到首位（主号）
let friendCodesArr = data.friendCodes || [];
const existIdx = friendCodesArr.findIndex(f => String(f.id) === String(sid));
if (existIdx !== -1) {
const [moved] = friendCodesArr.splice(existIdx, 1);
moved.name = sname; // 更新名字
friendCodesArr.unshift(moved);
} else {
friendCodesArr.unshift({
id: String(sid),
code: String(sid),
name: sname,
avatar: '',
region: 'cn'
});
}
friendCodes = friendCodesArr;
updateFriendCodesStore();
renderFriendCodes();
console.log(`✅ [网页] 识别到当前登录用户: ${sname} (${sid})`);
} else if (data.friendCodes && Array.isArray(data.friendCodes)) {
friendCodes = data.friendCodes;
renderFriendCodes();
}
// 恢复愿望单 (优先于 parseSteamData)
if (data.wishlist && Array.isArray(data.wishlist)) {
userLibrary.wishlist = new Set(data.wishlist);
console.log(`📦 [网页] 已恢复愿望单: ${userLibrary.wishlist.size} 个`);
}
// 恢复收藏
if (data.favorites) {
data.favorites.forEach(id => favorites.add(id));
favoritesLoaded = true;
applyDefaultSort();
}
// 🔄 自动静默同步：有 Key 且有好友码时自动触发
if (apiKeyExists && friendCodes.length > 0) {
console.log('🔄 [自动同步] 条件满足，启动静默同步...');
setTimeout(() => fetchSteamData(true), 500);
}
// [V1.1.2] 初始化自动同步按钮 UI
updateAutoSyncBtnUI(localStorage.getItem('auto_sync_userdata') === 'true');
// [V1.1.1] 请求油猴脚本恢复 Package 凭证数据
const mainSteamId = (friendCodes[0] && friendCodes[0].id) || '';
if (mainSteamId) {
window.dispatchEvent(new CustomEvent('LOAD_PACKAGE_DATA', {
detail: { steamId: mainSteamId }
}));
console.log(`📦 [网页] 向油猴请求恢复 Package 凭证 (steamId=${mainSteamId})`);
}
// [V1.1.2] 触发自动 userdata 同步
if (localStorage.getItem('auto_sync_userdata') === 'true') {
console.log('🔄 [自动同步] 发现开关开启，请求自动拉取 userdata...');
window.dispatchEvent(new CustomEvent('AUTO_SYNC_USERDATA_REQUEST'));
}
});
// [V1.1.2] 监听 userdata 自动同步返回
window.addEventListener('AUTO_SYNC_USERDATA_RESPONSE', function(e) {
const { success, data } = e.detail;
if (success && data) {
parseSteamData(data, 'self');
resetAndRender();
showSyncToast('✅ 自动从 userdata 刷新数据成功');
} else {
console.warn('⚠️ 自动提取 userdata 失败或暂未登录 Steam Store');
}
});
// [TOP100] 监听油猴返回的 TOP100 热榜数据
window.addEventListener('STEAM_TOP100_RESPONSE', function(e) {
const { appIds } = e.detail;
console.log('🔥 [网页] 收到 TOP100 数据:', appIds.length, '个游戏');
// 注入官方绝对排名
appIds.forEach((appId, index) => {
const game = gameById[appId];
if (game) {
game._top100Rank = index + 1;
}
});
// 更新全局缓存并重新触发渲染流水线
globalTop100Cache = appIds;
refreshDisplay();
});
// [V1.1.1] 监听油猴脚本返回的 Package 凭证数据
window.addEventListener('PACKAGE_DATA_LOADED', function(e) {
const pkgArr = (e.detail && e.detail.data) || [];
if (Array.isArray(pkgArr) && pkgArr.length > 0) {
pkgArr.forEach(n => userLibrary.ownedPackages.add(n));
console.log(`📦 [恢复] 从油猴存储恢复 ${userLibrary.ownedPackages.size} 个 Package SubID`);
// 凭证恢复后执行撞库推演
refreshBundleOwnership();
}
});
function renderFriendCodes() {
const list = document.getElementById('friendCodeList');
if (!list) return;
// 使用 DocumentFragment 优化 DOM 重绘
const frag = document.createDocumentFragment();
if (friendCodes.length === 0) {
const div = document.createElement('div');
div.className = 'friend-code-item';
div.innerHTML = `
<div class="friend-info"><div class="friend-avatar" style="background:#3d4450"></div><div class="friend-name" style="color:#8f98a0">主账号 (默认)</div></div>
`;
frag.appendChild(div);
list.innerHTML = '';
list.appendChild(frag);
return;
}
friendCodes.forEach((item, index) => {
const div = document.createElement('div');
// 动态角色着色：第1个=主账号(绿色)，2~6=家庭组(紫色)
const roleClass = index === 0 ? 'role-primary' : 'role-family';
const roleLabel = index === 0
? '<span class="friend-role primary">主账号</span>'
: '<span class="friend-role family">家庭组</span>';
div.className = `friend-code-item ${roleClass}`;
div.draggable = true;
div.dataset.index = index;
const selectedRegionCode = item.region || 'cn';
const selectedRegionName = REGION_ABBR_MAP[REGIONS.find(r=>r.code===selectedRegionCode)?.name] || selectedRegionCode;
const flagUrl = getFlagUrl(selectedRegionCode === 'BD' ? 'bd' : selectedRegionCode);
const regionDropdownHtml = `<div class="friend-region-btn" onclick="openFriendRegionModal(${index}, event)"><img src="${flagUrl}"><span>${escapeHtml(selectedRegionName)}</span></div>`;
div.innerHTML = `
<div class="friend-info"><img class="friend-avatar" src="${item.avatar || ''}" onerror="this.style.background='#2a475e'"><div><div class="friend-name">${item.name || '未命名'} ${roleLabel}</div><div class="friend-id">${(() => {
let raw = item.code || item.id;
if (/^\d{17}$/.test(raw)) {
try {
return (BigInt(raw) - 76561197960265728n).toString();
} catch(e) { return raw; }
}
return raw;
})()}</div></div></div><div style="display:flex; align-items:center;">
${regionDropdownHtml}
<div class="friend-delete-btn" data-del-idx="${index}">✕</div></div>
`;
frag.appendChild(div);
});
list.innerHTML = '';
list.appendChild(frag);
}
// HTML5 拖拽排序 (事件委托在父容器)
(function initDragDrop() {
const list = document.getElementById('friendCodeList');
if (!list) return;
let dragIdx = null;
list.addEventListener('dragstart', function(e) {
const item = e.target.closest('.friend-code-item');
if (!item) return;
dragIdx = parseInt(item.dataset.index);
item.classList.add('dragging');
e.dataTransfer.effectAllowed = 'move';
});
list.addEventListener('dragover', function(e) {
e.preventDefault();
const item = e.target.closest('.friend-code-item');
if (!item) return;
list.querySelectorAll('.friend-code-item').forEach(el => el.classList.remove('drag-over'));
item.classList.add('drag-over');
});
list.addEventListener('dragleave', function(e) {
const item = e.target.closest('.friend-code-item');
if (item) item.classList.remove('drag-over');
});
list.addEventListener('drop', function(e) {
e.preventDefault();
list.querySelectorAll('.friend-code-item').forEach(el => {
el.classList.remove('dragging', 'drag-over');
});
const item = e.target.closest('.friend-code-item');
if (!item || dragIdx === null) return;
const dropIdx = parseInt(item.dataset.index);
if (dragIdx === dropIdx) return;
// 交换
const [moved] = friendCodes.splice(dragIdx, 1);
friendCodes.splice(dropIdx, 0, moved);
dragIdx = null;
renderFriendCodes();
updateFriendCodesStore();
});
list.addEventListener('dragend', function() {
dragIdx = null;
list.querySelectorAll('.friend-code-item').forEach(el => {
el.classList.remove('dragging', 'drag-over');
});
});
// 事件委托：删除按钮
list.addEventListener('click', function(e) {
const delBtn = e.target.closest('.friend-delete-btn');
if (!delBtn) return;
const idx = parseInt(delBtn.dataset.delIdx);
if (confirm('确定要删除该账号吗？')) {
friendCodes.splice(idx, 1);
updateFriendCodesStore();
renderFriendCodes();
}
});
})();
let currentEditingFriendIndex = null;
function openFriendRegionModal(index, event) {
if (event) event.stopPropagation();
currentEditingFriendIndex = index;
const grid = document.getElementById('regionModalGrid');
let html = '';
REGIONS.forEach(r => {
const fCode = r.code === 'BD' ? 'bd' : r.code;
const rName = REGION_ABBR_MAP[r.name] || r.name;
html += `<div class="region-grid-btn" onclick="confirmFriendRegion('${r.code}')"><img src="${getFlagUrl(fCode)}"><span>${escapeHtml(rName)}</span></div>`;
});
grid.innerHTML = html;
document.getElementById('friendRegionModalOverlay').classList.add('active');
}
function closeFriendRegionModal() {
document.getElementById('friendRegionModalOverlay').classList.remove('active');
currentEditingFriendIndex = null;
}
function confirmFriendRegion(regionCode) {
if (currentEditingFriendIndex !== null && friendCodes[currentEditingFriendIndex]) {
friendCodes[currentEditingFriendIndex].region = regionCode;
updateFriendCodesStore();
renderFriendCodes();
}
closeFriendRegionModal();
}
// 批量智能解析 ID
function addFriendCodes() {
const input = document.getElementById('friendCodeInput');
const raw = input.value.trim();
if (!raw) return;
// 多分隔符切割：先将中文逗号和分号替换为英文逗号，然后按逗号/空格/换行切割
const cleanRaw = raw.replace(/，/g, ',').replace(/；/g, ',').replace(/;/g, ',');
const tokens = cleanRaw.split(/[,\s\n]+/).filter(t => t.length > 0);
let added = 0;
let skipped = 0;
for (const token of tokens) {
if (!/^\d+$/.test(token)) { skipped++; continue; }
if (friendCodes.length >= 6) break;
let steamId = token;
let displayCode = token;
try {
const bigVal = BigInt(token);
if (bigVal < 76561197960265728n) {
steamId = (bigVal + 76561197960265728n).toString();
displayCode = token;
}
} catch (e) { skipped++; continue; }
// 去重
if (friendCodes.some(f => f.id === steamId)) { skipped++; continue; }
friendCodes.push({
id: steamId,
code: displayCode,
name: '加载中...',
avatar: '',
region: friendCodes.length > 0 ? (friendCodes[0].region || 'cn') : 'cn'
});
fetchSteamPlayerInfo(steamId, friendCodes.length - 1);
added++;
}
updateFriendCodesStore();
renderFriendCodes();
input.value = '';
if (added > 0) {
showSyncToast(`✅ 已添加 ${added} 个账号` + (skipped > 0 ? `，跳过 ${skipped} 个` : ''));
} else if (skipped > 0) {
showSyncToast(`⚠️ ${skipped} 个ID格式不正确或已存在`);
}
}
function updateFriendCodesStore() {
window.dispatchEvent(new CustomEvent('STEAM_DATA_UPDATE', {
detail: { type: 'friendCodes', data: friendCodes }
}));
}
// 获取玩家基本信息 (Avatar, Name)
function fetchSteamPlayerInfo(steamId, index) {
window.dispatchEvent(new CustomEvent('STEAM_API_FETCH', {
detail: { type: 'summary', steamIds: steamId, reqId: 'summary_' + index }
}));
}
// 获取拥有游戏 (Owned Games)  — silent=true 时静默模式
function fetchSteamData(silent) {
if (!apiKeyExists) {
if (!silent) alert('⚠️ 未检测到 API Key，请先配置！');
return;
}
if (friendCodes.length === 0) {
if (!silent) alert('请先添加账号 ID');
return;
}
friendCodes.forEach((item, idx) => {
window.dispatchEvent(new CustomEvent('STEAM_API_FETCH', {
detail: { type: 'owned', steamIds: item.id, reqId: 'owned_' + idx }
}));
// 同时刷新头像
fetchSteamPlayerInfo(item.id, idx);
// 派发愿望单请求
window.dispatchEvent(new CustomEvent('STEAM_API_FETCH', {
detail: { type: 'wishlist', steamIds: item.id, reqId: 'wishlist_' + idx }
}));
});
if (silent) {
showSyncToast('🔄 正在后台同步 Steam 数据...');
} else {
showSyncToast('🔄 已发送同步请求，请稍候...');
}
}
// 监听 API 响应
let pendingOwnedResponses = 0;
window.addEventListener('STEAM_API_RESPONSE', function(e) {
const { reqId, type, success, data, error } = e.detail;
if (!success) {
console.warn(`API 请求失败 [${reqId}]:`, error);
if (error && error.includes('API_KEY_INVALID')) {
showSyncToast('❌ API Key 无效: ' + error, 5000);
}
return;
}
if (type === 'summary') {
const players = data.response ? data.response.players : null;
if (players && players.length > 0) {
const idx = parseInt(reqId.split('_')[1]);
if (friendCodes[idx]) {
friendCodes[idx].name = players[0].personaname;
friendCodes[idx].avatar = players[0].avatar;
renderFriendCodes();
updateFriendCodesStore();
}
}
} else if (type === 'owned') {
const idx = parseInt(reqId.split('_')[1]);
const ownerName = (friendCodes[idx] && friendCodes[idx].name) || '未知';
const games = data.response ? data.response.games : null;
if (games && Array.isArray(games)) {
hasApiData = true;
if (idx === 0) {
// 主账号 → owned
let newCount = 0;
// 时间切片写入防卡死
const chunk = 1000;
let i = 0;
function processChunk() {
const end = Math.min(i + chunk, games.length);
for (; i < end; i++) {
if (!userLibrary.owned.has(games[i].appid)) {
userLibrary.owned.add(games[i].appid);
newCount++;
}
}
if (i < games.length) {
setTimeout(processChunk, 10);
} else {
console.log(`✅ [API] 主账号库存: +${newCount} (总: ${userLibrary.owned.size})`);
const syncBtn = document.getElementById('syncBtn');
if (syncBtn) syncBtn.classList.add('synced');
showSyncToast(`✅ 主账号: ${userLibrary.owned.size} 款游戏`);
resetAndRender();
// [Fix4] 实时刷新捆绑包状态
if (bundleMode) { renderBundleGrid(); }
refreshBundleOwnership();
}
}
processChunk();
} else {
// 家庭组 → familyMap，结合 fs 属性过滤
let familyCount = 0;
const chunk = 1000;
let i = 0;
function processFamilyChunk() {
const end = Math.min(i + chunk, games.length);
for (; i < end; i++) {
const g = games[i];
const appId = g.appid;
// 不加入主账号已有的
if (userLibrary.owned.has(appId)) continue;
// 查询大 JSON 的 fs 属性过滤不可共享的游戏
const gameInfo = rawGameData.find(rd => rd.id === appId);
if (gameInfo && gameInfo.fs !== 1) continue;
// 追加 owner
if (userLibrary.familyMap.has(appId)) {
const owners = userLibrary.familyMap.get(appId);
if (!owners.includes(ownerName)) owners.push(ownerName);
} else {
userLibrary.familyMap.set(appId, [ownerName]);
}
familyCount++;
}
if (i < games.length) {
setTimeout(processFamilyChunk, 10);
} else {
console.log(`✅ [API] 家庭成员 "${ownerName}": +${familyCount} 可共享`);
showSyncToast(`✅ ${ownerName}: +${familyCount} 款可共享`);
resetAndRender();
// [Fix4] 实时刷新捆绑包状态
if (bundleMode) { renderBundleGrid(); }
refreshBundleOwnership();
}
}
processFamilyChunk();
}
}
} else if (type === 'wishlist') {
const idx = parseInt(reqId.split('_')[1]);
const ownerName = (friendCodes[idx] && friendCodes[idx].name) || '未知';
const items = data.response ? data.response.items : null;
if (!items || !Array.isArray(items)) {
// 隐私未公开，静默 return
return;
}
hasApiData = true;
if (idx === 0) {
// 主账号 → wishlist
let newCount = 0;
// 时间切片写入防卡死
const chunk = 1000;
let i = 0;
function processWishlistChunk() {
const end = Math.min(i + chunk, items.length);
for (; i < end; i++) {
const g = items[i];
if (!userLibrary.wishlist.has(g.appid)) {
userLibrary.wishlist.add(g.appid);
newCount++;
}
}
if (i < items.length) {
setTimeout(processWishlistChunk, 10);
} else {
console.log(`✅ [API] 主账号愿望单: +${newCount} (总: ${userLibrary.wishlist.size})`);
showSyncToast(`✅ 主账号愿望单: ${userLibrary.wishlist.size} 款游戏`);
resetAndRender();
}
}
processWishlistChunk();
} else {
// 家庭组 → familyWishlistMap
let familyCount = 0;
const chunk = 1000;
let i = 0;
function processFamilyWishlistChunk() {
const end = Math.min(i + chunk, items.length);
for (; i < end; i++) {
const g = items[i];
const appId = g.appid;
// 追加 owner
if (userLibrary.familyWishlistMap.has(appId)) {
const owners = userLibrary.familyWishlistMap.get(appId);
if (!owners.includes(ownerName)) owners.push(ownerName);
} else {
userLibrary.familyWishlistMap.set(appId, [ownerName]);
}
familyCount++;
}
if (i < items.length) {
setTimeout(processFamilyWishlistChunk, 10);
} else {
console.log(`✅ [API] 家庭成员 "${ownerName}" 愿望单: +${familyCount}`);
showSyncToast(`✅ ${ownerName} 愿望单: +${familyCount} 款游戏`);
resetAndRender();
}
}
processFamilyWishlistChunk();
}
}
});
function clearWishlist() {
if (confirm('确定要清空本地缓存的愿望单吗？\n（油猴存储的数据也会被清空）')) {
userLibrary.wishlist.clear();
window.dispatchEvent(new CustomEvent('STEAM_DATA_UPDATE', {
detail: { type: 'wishlist', data: [] }
}));
alert('🗑️ 愿望单已清空');
resetAndRender();
}
}
// ==================== [V1.2] Bundle 模式 ====================
let bundleMode = false;
const bundleGrid = document.getElementById('bundleGrid');
const bundleView = document.getElementById('bundleView');
const bundlePopover = document.getElementById('bundlePopover');
const bundlePriceGrid = document.getElementById('bundlePriceGrid');
const bundleGameList = document.getElementById('bundleGameList');
const bundleStatusValue = document.getElementById('bundleStatusValue');
const bundleLockHint = document.getElementById('bundleLockHint');
const saPopup = document.getElementById('saPopup');
const agrDetailPopup = document.getElementById('agrDetailPopup');
let currentBundleId = null;
// 地区代码 → 名称映射（含 BD）
const BUNDLE_REGION_NAMES = {};
REGIONS.forEach(r => { BUNDLE_REGION_NAMES[r.code] = r.name; });
BUNDLE_REGION_NAMES['BD'] = '孟加拉';
BUNDLE_REGION_NAMES['pk'] = '巴基斯坦';
// ==================== 撞库推演算法 ====================
function inferBundleOwnership(bundle) {
// 返回: { type: 'owned'|'family'|null, account: string|null }
const baselineAppIds = (bundle.bl || []).map(Number);
if (baselineAppIds.length === 0) return { type: null, account: null };
// 条件 A：确诊（当前账号已购买该 Package/Bundle 的 SubID/Bid）
if (userLibrary.ownedPackages && userLibrary.ownedPackages.has(bundle.bid)) {
return { type: 'owned', account: '我' };
}
// 条件 B：该捆绑包内包含的所有有效游戏（AppID），均存在于当前账号的“已拥有”或“家庭共享”列表中
// 过滤出单品数据存在的“有效游戏”（排除无数据岛和占位符）
const validAppIds = baselineAppIds.filter(aid => gameById[aid]);
if (validAppIds.length > 0) {
let allOwnedOrFamily = true;
let isPureFamily = true; // 是否全靠家庭共享组成的
let anyFamilyAccount = null;
for (const aid of validAppIds) {
const isSelf = userLibrary.owned.has(aid);
const isFamily = userLibrary.familyMap.has(aid);
if (!isSelf && !isFamily) {
allOwnedOrFamily = false;
break;
}
if (isSelf) {
isPureFamily = false;
} else if (isFamily && !anyFamilyAccount) {
const owners = userLibrary.familyMap.get(aid);
if (owners && owners.length > 0) {
anyFamilyAccount = owners[0];
}
}
}
if (allOwnedOrFamily) {
// 若完全依赖家庭共享拼凑出来的包
if (isPureFamily && anyFamilyAccount) {
return { type: 'family', account: anyFamilyAccount };
} else {
// 混编或者全为自购，视作主号已拥有（显示已拥有）
return { type: 'owned', account: '我' };
}
}
}
return { type: null, account: null };
}
function toggleBundleMode() {
bundleMode = !bundleMode;
const btn = document.querySelector('.sort-btn[data-sort="bundle"]');
if (bundleMode) {
// 进入 Bundle 模式
document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
btn.classList.add('active');
cardGrid.style.display = 'none';
loader.style.display = 'none';
document.getElementById('filterToolbar').style.display = 'none';
bundleView.style.display = 'block';
renderBundleGrid();
stats.textContent = `共 ${bundleData.length} 个捆绑包`;
} else {
// 退出 Bundle 模式
btn.classList.remove('active');
bundleView.style.display = 'none';
cardGrid.style.display = '';
loader.style.display = '';
closeBundlePopover();
closeSAPopup();
closeAGRPopup();
// 恢复默认下拉选择
const sortSelect = document.getElementById('sortSelect');
if (sortSelect) sortSelect.value = 'default';
resetAndRender();
}
}
function renderBundleGrid(dataList = bundleData) {
if (!dataList || dataList.length === 0) {
bundleGrid.innerHTML = '<div style="text-align:center;padding:40px;color:#8f98a0;">暂无捆绑包数据</div>';
return;
}
const isHideOwned = getIsHideOwned();
let html = '';
dataList.forEach((b, idx) => {
const storeUrl = `https://store.steampowered.com/${b.mps === 1 ? 'sub' : 'bundle'}/${b.bid}/`;
const imgUrl = b.img || '';
// ===== 折扣角标 =====
let maxDp = 0;
if (b.rp) {
Object.values(b.rp).forEach(r => {
if (r.dp && r.dp > maxDp) maxDp = r.dp;
});
}
const discountBadge = maxDp > 0 ? `<div class="discount-badges-container"><span class="discount-badge">-${maxDp}%</span></div>` : '';
// ===== 撞库推演 → cover-wrapper 内的状态角标 =====
let cardClass = 'game-card';
let statusBadge = '';
const ownerInfo = inferBundleOwnership(b);
if (isHideOwned && (ownerInfo.type === 'owned' || ownerInfo.type === 'family')) return;
if (ownerInfo.type === 'owned') {
cardClass += ' owned';
const ownersStr = escapeHtml(JSON.stringify(['我']));
statusBadge = `<div class="status-badge owned" data-owners="${ownersStr}" data-type="owned" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">已拥有<span style="font-size: 9px; color: rgba(27,40,56,0.65); margin-left: 2px; font-weight: normal;">?</span></div>`;
} else if (ownerInfo.type === 'family') {
cardClass += ' family';
const ownersArr = ownerInfo.account ? [ownerInfo.account] : [];
const ownersStr = escapeHtml(JSON.stringify(ownersArr));
statusBadge = `<div class="status-badge family" data-owners="${ownersStr}" data-type="family" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">家庭组<span style="font-size: 9px; color: rgba(255,255,255,0.75); margin-left: 2px; font-weight: normal;">?</span></div>`;
}
// ===== MPS 标签 =====
let mpsHtml = '';
if (b.mps === 0) {
mpsHtml = '<span class="bundle-mps-tag completable">✅ 支持补齐</span>';
} else if (b.mps === 1) {
mpsHtml = '<span class="bundle-mps-tag must-buy">❌ 不支持补齐</span>';
} else {
mpsHtml = '<span class="bundle-mps-tag unknown">❓ 未知</span>';
}
// ===== 基础折扣标签 =====
let bdTag = '';
const firstRegion = Object.values(b.rp || {})[0];
if (firstRegion && firstRegion.bd > 0) {
bdTag = `<span class="bundle-base-discount-tag">基础折扣 ${firstRegion.bd}%</span>`;
}
// ===== 价格区 =====
const cnPriceStr = b.cp !== null ? '¥' + b.cp.toFixed(2) : '暂无';
const diffVal = b.df || 0;
const diffBadge = diffVal > 0
? `<span class="diff-badge positive"><span class="align-text-up">省¥${diffVal.toFixed(0)}</span></span>`
: `<span class="diff-badge"><span class="align-text-up">无差价</span></span>`;
// ===== 前三低价区 (复用 .top3-row 类名) =====
let top3Html = '';
const rp = b.rp || {};
if (b.cp !== null) {
const cheaperRegions = [];
Object.keys(rp).forEach(code => {
if (code === 'cn') return;
const rd = rp[code];
if (rd && rd.cny !== null && rd.cny < b.cp) {
const fc = code === 'BD' ? 'bd' : code;
const nm = BUNDLE_REGION_NAMES[code] || code;
cheaperRegions.push({ code: fc, name: nm, cny: rd.cny });
}
});
cheaperRegions.sort((a, c) => a.cny - c.cny);
const top3 = cheaperRegions.slice(0, 3);
if (top3.length > 0) {
top3.forEach(r => {
top3Html += `<div class="price-row top3-row"><span class="price-label"><img class="flag-icon" src="${getFlagUrl(r.code)}" alt="${escapeHtml(r.name)}" onerror="this.style.display='none'">${escapeHtml(r.name)}</span><span class="price-value lowest">¥${r.cny.toFixed(2)}</span></div>`;
});
} else {
// 国区最低
const lowestName = BUNDLE_REGION_NAMES[b.lc] || b.lc;
const lowestCode = (b.lc === 'BD') ? 'bd' : b.lc;
const lowestPriceStr = b.lv !== null ? '¥' + b.lv.toFixed(2) : '暂无';
top3Html = `<div class="price-row"><span class="price-label"><img class="flag-icon" src="${getFlagUrl(lowestCode)}" alt="${escapeHtml(lowestName)}" onerror="this.style.display='none'">${escapeHtml(lowestName)} 最低</span><span class="price-value lowest">${lowestPriceStr}</span></div>`;
}
} else {
top3Html = '';
}
// ===== 全区价格明细 (detail-item, 内联展开用) =====
let detailsHTML = '';
const cnCny = b.cp;
let hasLocked = false;
// 南亚判断
const hasPK = !!rp['pk'];
const hasBDRegion = !!rp['BD'];
// CN
detailsHTML += `<div class="detail-item cn-region" onclick="showGiftingPopup(${b.bid}, 'cn', event, true)"><img class="flag" src="${getFlagUrl('cn')}" alt="中国" onerror="this.style.display='none'"><span class="name">中国</span><div class="prices"><span class="cny">${b.cp !== null ? '¥' + b.cp.toFixed(2) : '锁区'}</span></div></div>`;
// 其他区域
const displayOrder = ['cn'];
REGIONS_NON_CN.forEach(r => {
if (r.code === 'pk') {
displayOrder.push('pk');
displayOrder.push('BD');
} else {
displayOrder.push(r.code);
}
});
displayOrder.forEach(code => {
if (code === 'cn') return;
const rd = rp[code];
const name = BUNDLE_REGION_NAMES[code] || code;
const flagCode = code === 'BD' ? 'bd' : code;
const isLowest = code === b.lc;
if (!rd) {
detailsHTML += `<div class="detail-item${isLowest ? ' lowest-region' : ''}" onclick="showGiftingPopup(${b.bid}, '${code}', event, true)"><img class="flag" src="${getFlagUrl(flagCode)}" alt="${escapeHtml(name)}" onerror="this.style.display='none'"><span class="name">${escapeHtml(name)}</span><span class="locked">锁区</span></div>`;
return;
}
const locked = rd.lk > 0;
if (locked) hasLocked = true;
let priceClass = 'same';
if (cnCny !== null && rd.cny !== null) {
if (rd.cny < cnCny - 1) priceClass = 'cheaper';
else if (rd.cny > cnCny + 1) priceClass = 'expensive';
}
const itemCls = `detail-item${locked ? ' partial-lock' : ''}${isLowest ? ' lowest-region' : ''}`;
detailsHTML += `<div class="${itemCls}" style="cursor:pointer;" onclick="showGiftingPopup(${b.bid}, '${code}', event, true)"><img class="flag" src="${getFlagUrl(flagCode)}" alt="${escapeHtml(name)}" onerror="this.style.display='none'"><span class="name">${escapeHtml(name)}</span><div class="prices"><span class="orig">${escapeHtml(rd.p || '无价格')}</span><span class="cny ${priceClass}">${rd.cny !== null ? '¥' + rd.cny.toFixed(2) : '-'}</span></div></div>`;
});
// ===== 锁区提示 =====
const lockHintHtml = hasLocked ? '<div class="bundle-lock-hint">ℹ️ 浅黄色背景表示该地区部分游戏锁区</div>' : '';
// ===== 补齐状态栏 =====
let statusBarHtml = '<div class="bundle-status-bar"><span class="bundle-status-label">补齐状态:</span>';
if (ownerInfo.type === 'owned') {
statusBarHtml += '<span class="bundle-status-value owned" style="color:#a8e6cf; font-weight:bold;">✅ 已拥有全部内容</span></div>';
} else if (ownerInfo.type === 'family') {
statusBarHtml += '<span class="bundle-status-value family" style="color:#d4a5ea; font-weight:bold;">✅ 家庭组已拥有全套</span></div>';
} else if (b.mps === 0) {
statusBarHtml += '<span class="bundle-status-value completable">✅ 支持补齐</span></div>';
statusBarHtml += `<div class="bundle-calc-entry" style="text-align:center; padding: 4px 0 8px 0; border-bottom: 1px dotted rgba(255,255,255,0.1); margin-bottom: 8px;"><span style="color:#66c0f4; text-decoration:underline; font-size:13px; font-weight:bold; cursor:pointer; text-shadow: 0 0 5px rgba(102,192,244,0.4);" onclick="openBundleCalculator(event, ${b.bid})">✨ 计算购买捆绑包价格 ✨</span></div>`;
} else {
statusBarHtml += '<span class="bundle-status-value">❓ 未知</span></div>';
}
// ===== 游戏列表 HTML (内联) =====
const gameListHTML = buildBundleGameListHTML(b);
// ===== 拼装完整的 game-card 结构 =====
html += `
<div class="${cardClass}" data-bidx="${idx}"><div class="cover-wrapper">
${statusBadge}
<span class="cover-placeholder">📦</span>
${imgUrl ? `<img class="cover" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(b.n)}" loading="lazy" onerror="this.style.display='none';this.previousElementSibling.style.display='block';">` : ''}
${discountBadge}
<span class="appid-badge">${b.bid}</span></div><div class="info"><div class="title-row"><h3 class="game-title">${escapeHtml(b.n)}</h3></div><div class="tags-row">
${mpsHtml}${bdTag}
<a href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener" class="steam-btn" onclick="event.stopPropagation()"><span class="steam-icon"></span><span>STEAM商店</span></a></div><div class="price-section"><div class="price-row"><span class="price-label"><img class="flag-icon" src="${getFlagUrl('cn')}" alt="中国" onerror="this.style.display='none'">国区
</span><span class="price-value cn">${cnPriceStr}</span></div>
${top3Html}
<div class="price-row"><span class="price-label">差价</span><div class="price-diff">${diffBadge}</div></div></div><button class="details-btn" onclick="toggleBundleDetails(event, ${b.bid})"><span class="arrow">▼</span> 全区价格
</button><div class="bundle-details-container" id="bundle-details-${b.bid}" style="display: none;">
${statusBarHtml}
${lockHintHtml}
<div class="details-grid">${detailsHTML}</div><div class="bundle-game-section"><div class="bundle-game-title">🎮 捆绑包包含游戏</div>
${gameListHTML}
</div></div></div></div>
`;
});
bundleGrid.innerHTML = html;
}
// [Fix3] 展开/折叠 Bundle 详情 (兼容 PC悬浮窗 与 手机内联)
function toggleBundleDetails(event, bid) {
event.stopPropagation();
event.preventDefault();
if (isMobile()) {
const container = document.getElementById('bundle-details-' + bid);
const btn = event.currentTarget;
if (!container) {
console.warn('[toggleBundleDetails] 找不到容器: bundle-details-' + bid);
return;
}
const isOpen = container.style.display === 'block';
if (isOpen) {
container.style.display = 'none';
btn.classList.remove('open');
} else {
container.style.display = 'block';
btn.classList.add('open');
}
} else {
// PC 端弹出 Popover
if (bundlePopover.classList.contains('open') && currentBundleId === bid) {
closeBundlePopover();
} else {
showBundlePopover(bid, event.currentTarget.closest('.game-card'));
}
}
}
currentBundleId = null;
// PC端悬浮窗显示
function showBundlePopover(bid, card) {
currentBundleId = bid;
const bundle = bundleByBid[bid];
if (!bundle) return;
// 复制基础信息
const headerCover = document.getElementById('bundlePopoverCover');
const titleEl = document.getElementById('bundlePopoverTitle');
if (bundle.img) {
headerCover.src = bundle.img;
headerCover.style.display = 'block';
} else {
headerCover.style.display = 'none';
}
titleEl.textContent = bundle.n;
// 从内联容器复制内容
const inlineContainer = document.getElementById('bundle-details-' + bid);
if (!inlineContainer) return;
// 复制价格网格 (替换类名以适配 PC popover 样式)
const inlineGrid = inlineContainer.querySelector('.details-grid');
if (inlineGrid) {
bundlePriceGrid.innerHTML = inlineGrid.innerHTML.replace(/"detail-item/g, '"popover-item');
} else {
bundlePriceGrid.innerHTML = '';
}
// 复制游戏列表和差价行
const inlineGameSection = inlineContainer.querySelector('.bundle-game-section');
const popoverGameSection = bundlePopover.querySelector('.bundle-game-section');
if (inlineGameSection && popoverGameSection) {
popoverGameSection.innerHTML = inlineGameSection.innerHTML;
}
// 同步状态标签
const inlineStatus = inlineContainer.querySelector('.bundle-status-value');
if (inlineStatus) {
bundleStatusValue.innerHTML = inlineStatus.innerHTML;
bundleStatusValue.className = inlineStatus.className;
}
// 同步计算器按钮
const calcBtnContainer = document.getElementById('bundleCalcBtnContainer');
if (calcBtnContainer) {
if (bundle.mps === 0) {
calcBtnContainer.innerHTML = `<span style="color:#66c0f4; text-decoration:underline; font-size:13px; font-weight:bold; cursor:pointer; text-shadow: 0 0 5px rgba(102,192,244,0.4);" onclick="openBundleCalculator(event, ${bid})">✨ 计算购买捆绑包价格 ✨</span>`;
calcBtnContainer.style.display = 'block';
} else {
calcBtnContainer.style.display = 'none';
}
}
// 同步锁区提示
const inlineLock = inlineContainer.querySelector('.bundle-lock-hint');
if (inlineLock) {
bundleLockHint.innerHTML = inlineLock.innerHTML;
bundleLockHint.style.display = 'flex';
} else {
bundleLockHint.style.display = 'none';
}
// 定位计算
const rect = card.getBoundingClientRect();
const popoverWidth = 320; // 悬浮窗固定宽度
let top = rect.top + window.scrollY;
let left = rect.right + 15;
// 右侧空间不足时，切换到左侧
if (left + popoverWidth > window.innerWidth) {
left = rect.left - popoverWidth - 15;
}
if (left < 10) left = 10;
// 底部空间不足时，限制最大 top 值
const maxTop = window.scrollY + window.innerHeight - 450;
if (top > maxTop) top = maxTop;
if (top < window.scrollY + 10) top = window.scrollY + 10;
bundlePopover.style.top = top + 'px';
bundlePopover.style.left = left + 'px';
bundlePopover.classList.add('open');
}
// 构建游戏列表 HTML (纯字符串返回，不操作 DOM)
function buildBundleGameListHTML(bundle) {
const bl = bundle.bl || [];
if (bl.length === 0) return '<div style="padding:8px;color:#8f98a0;">无游戏数据</div>';
const rp = bundle.rp || {};
const regionGroups = {};
Object.keys(rp).forEach(code => {
const aids = rp[code].aids || [];
const key = aids.slice().sort((a,b) => a-b).join(',');
if (!regionGroups[key]) regionGroups[key] = { codes: [], aids: aids };
regionGroups[key].codes.push(code);
});
const groups = Object.values(regionGroups).sort((a, c) => c.aids.length - a.aids.length);
let html = '';
// 如果只有 1 个分组（即各区无差异），或者没有区域信息，正常渲染顶部游戏列表
if (groups.length <= 1) {
html += '<div class="bundle-game-list">';
const showCount = bl.length > 4 ? 4 : bl.length;
for (let i = 0; i < showCount; i++) {
const appid = bl[i];
const aid = String(appid);
const headerUrl = bundleHeaderCache[aid] || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${aid}/header.jpg`;
const game = gameById[parseInt(aid)];
const gameName = game ? game.n : `AppID: ${aid}`;
const aidInt = parseInt(aid);
let statusClass = '';
let titleExtra = '';
if (userLibrary.owned.has(aidInt)) {
statusClass = 'bgc-owned'; titleExtra = ' [已拥有]';
} else if (userLibrary.familyMap.has(aidInt)) {
statusClass = 'bgc-family';
const owners = userLibrary.familyMap.get(aidInt);
titleExtra = ` [家庭组: ${owners ? owners.join(', ') : ''}]`;
} else if (userLibrary.wishlist.has(aidInt)) {
statusClass = 'bgc-wishlist'; titleExtra = ' [愿望单]';
} else if (userLibrary.familyWishlistMap.has(aidInt)) {
statusClass = 'bgc-wishlist';
const owners = userLibrary.familyWishlistMap.get(aidInt);
titleExtra = ` [${owners ? owners[0] : ''}的愿望单]`;
} else if (favorites.has(aidInt)) {
statusClass = 'bgc-favorite'; titleExtra = ' [已收藏]';
}
html += `<div class="bundle-game-card ${statusClass}" title="${escapeHtml(gameName + titleExtra)}"><img src="${escapeHtml(headerUrl)}" alt="${escapeHtml(gameName)}" loading="lazy" onerror="this.style.display='none'"><div class="bgc-name">${escapeHtml(gameName)}</div></div>`;
}
if (bl.length > 4) {
html += `<div class="view-all-games-btn" style="color: #66c0f4; cursor: pointer; text-align: center; padding: 10px 0; font-size: 12px; grid-column: 1 / -1;" onclick="showAllBundleGamesPopup(event, this, ${bundle.bid})">查看全部 ${bl.length} 款游戏</div>`;
}
html += '</div>';
}
// 差异分组行
if (groups.length > 1) {
html += '<div style="margin-top:8px; border-top: 1px solid rgba(102,192,244,0.15); padding-top: 6px;">';
html += '<div style="font-size:11px; color:#8f98a0; padding:2px 12px;">地区 AppID 差异：</div>';
groups.forEach((g, gIdx) => {
const flagsHtml = g.codes.map(c => {
const fc = c === 'BD' ? 'bd' : c;
const nm = BUNDLE_REGION_NAMES[c] || c;
return `<img src="${getFlagUrl(fc)}" alt="${escapeHtml(nm)}" title="${escapeHtml(nm)}" onerror="this.style.display='none'">`;
}).join('');
html += `<div class="appid-group-row" data-agr-idx="${gIdx}" onclick="showAGRDetailPopup(this, ${JSON.stringify(g.aids)}, ${JSON.stringify(bl)})"><div class="agr-flags">${flagsHtml}</div><span class="agr-count">${g.aids.length} 款游戏</span></div>`;
});
html += '</div>';
}
return html;
}
// [兼容] 旧 renderBundleGameList (现在由 buildBundleGameListHTML 替代，保留空壳)
function renderBundleGameList(bundle) {}
// [V1.3] 撞库推演手动刷新 — 在数据加载完毕后调用
function refreshBundleOwnership() {
if (!bundleData || bundleData.length === 0) return;
console.log('🔄 [撞库] 开始刷新捆绑包拥有状态...');
let matched = 0;
bundleData.forEach((b, idx) => {
const ownerInfo = inferBundleOwnership(b);
const card = bundleGrid.querySelector(`.game-card[data-bidx="${idx}"]`);
if (!card) return;
const wrapper = card.querySelector('.cover-wrapper');
if (!wrapper) return;
// 移除旧角标
const oldBadge = wrapper.querySelector('.status-badge');
if (oldBadge) oldBadge.remove();
card.classList.remove('owned', 'family');
// 添加新角标
if (ownerInfo.type === 'owned') {
card.classList.add('owned');
const ownersStr = escapeHtml(JSON.stringify(['我']));
wrapper.insertAdjacentHTML('afterbegin', `<div class="status-badge owned" data-owners="${ownersStr}" data-type="owned" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">已拥有<span style="font-size: 9px; color: rgba(27,40,56,0.65); margin-left: 2px; font-weight: normal;">?</span></div>`);
matched++;
} else if (ownerInfo.type === 'family') {
card.classList.add('family');
const ownersArr = ownerInfo.account ? [ownerInfo.account] : [];
const ownersStr = escapeHtml(JSON.stringify(ownersArr));
wrapper.insertAdjacentHTML('afterbegin', `<div class="status-badge family" data-owners="${ownersStr}" data-type="family" onmouseenter="showAccountTooltip(event, this)" onmouseleave="hideAccountTooltip()">家庭组<span style="font-size: 9px; color: rgba(255,255,255,0.75); margin-left: 2px; font-weight: normal;">?</span></div>`);
matched++;
}
});
console.log(`✅ 捆绑包数据库匹配完成，命中 ${matched} 个`);
// [V1.1.1] 完成后强制刷新卡片渲染 + Toast 通知
if (bundleMode) renderBundleGrid();
showSyncToast('✅ 捆绑包数据库匹配完成');
}
// 关闭捆绑包弹窗
function closeBundlePopover() {
bundlePopover.classList.remove('open');
// 同步关闭计算器弹窗
if (typeof closeBundleCalculator === 'function') closeBundleCalculator();
bundlePopover.style.display = '';
currentBundleId = null;
closeSAPopup();
closeAGRPopup();
}
// ==================== 南亚弹窗 ====================
function showSAPopup(el, pkData, bdData) {
event.stopPropagation();
let html = '<div class="sa-popup-title">🌏 南亚地区价格详情</div>';
// PK
if (pkData) {
html += `<div class="detail-item${pkData.lk > 0 ? ' partial-lock' : ''}"><img class="flag" src="${getFlagUrl('pk')}" onerror="this.style.display='none'"><span class="name">巴基斯坦</span><div class="prices"><span class="orig">${escapeHtml(pkData.p || '')}</span><span class="cny">${pkData.cny !== null ? '¥' + pkData.cny.toFixed(2) : '-'}</span></div></div>`;
}
// BD
if (bdData) {
html += `<div class="detail-item${bdData.lk > 0 ? ' partial-lock' : ''}"><img class="flag" src="${getFlagUrl('bd')}" onerror="this.style.display='none'"><span class="name">孟加拉</span><div class="prices"><span class="orig">${escapeHtml(bdData.p || '')}</span><span class="cny">${bdData.cny !== null ? '¥' + bdData.cny.toFixed(2) : '-'}</span></div></div>`;
}
// 将弹窗移挂载到 document.body
document.body.appendChild(saPopup);
saPopup.innerHTML = html;
saPopup.style.display = 'block';
const rect = el.getBoundingClientRect();
let left = rect.right + 10;
let top = rect.top + window.scrollY;
// 边界检查
requestAnimationFrame(() => {
const popRect = saPopup.getBoundingClientRect();
if (popRect.right > window.innerWidth) {
left = rect.left - popRect.width - 10;
}
if (popRect.bottom > window.innerHeight) {
top = window.innerHeight + window.scrollY - popRect.height;
}
saPopup.style.left = left + 'px';
saPopup.style.top = top + 'px';
saPopup.style.marginLeft = '0';
});
}
function closeSAPopup() {
saPopup.style.display = 'none';
}
// ==================== AGR 差异行与全览弹窗 ====================
let calcExcludedApps = new Set();
let currentCalcBid = null;
function showAllBundleGamesPopup(event, el, bid, calcRegionCode = null) {
if (event) event.stopPropagation();
const bundle = bundleByBid[bid];
if (!bundle || !bundle.bl) return;
let aids = bundle.bl;
let isCalcMode = !!calcRegionCode;
if (isCalcMode) {
const rpData = bundle.rp[calcRegionCode];
if (rpData && rpData.aids) {
const regionAidsSet = new Set(rpData.aids.map(Number));
aids = bundle.bl.filter(aid => regionAidsSet.has(Number(aid)));
} else {
aids = [];
}
}
let html = `<div class="agr-popup-title">🎮 ${isCalcMode ? '选择' : ''}捆绑包包含 ${aids.length} 款游戏</div>`;
html += '<div class="agr-popup-grid">';
aids.forEach(appid => {
const aid = String(appid);
const headerUrl = bundleHeaderCache[aid] || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${aid}/header.jpg`;
const game = gameById[parseInt(aid)];
const gameName = game ? game.n : `AppID: ${aid}`;
const aidInt = parseInt(aid);
let statusClass = '';
let titleExtra = '';
if (userLibrary.owned.has(aidInt)) {
statusClass = 'bgc-owned'; titleExtra = ' [已拥有]';
} else if (userLibrary.familyMap.has(aidInt)) {
statusClass = 'bgc-family'; titleExtra = ' [家庭组]';
} else if (userLibrary.wishlist.has(aidInt)) {
statusClass = 'bgc-wishlist'; titleExtra = ' [愿望单]';
} else if (userLibrary.familyWishlistMap.has(aidInt)) {
statusClass = 'bgc-wishlist';
const owners = userLibrary.familyWishlistMap.get(aidInt);
titleExtra = ` [${owners ? owners[0] : ''}的愿望单]`;
} else if (favorites.has(aidInt)) {
statusClass = 'bgc-favorite'; titleExtra = ' [已收藏]';
}
const isExcluded = isCalcMode && calcExcludedApps.has(aidInt);
html += `<div class="bundle-game-card ${statusClass}" title="${escapeHtml(gameName + titleExtra)}"
${isCalcMode ? `onclick="toggleExcludeGame(event, this, ${aidInt})"` : ''}
style="${isCalcMode ? 'cursor:pointer;' : ''} position:relative;"><img src="${escapeHtml(headerUrl)}" alt="${escapeHtml(gameName)}" loading="lazy" onerror="this.style.display='none'"><div class="bgc-name">${escapeHtml(gameName)}</div>
${isExcluded ? `<div class="exclusion-mask" style="position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(231,76,60,0.6); display:flex; justify-content:center; align-items:center; z-index:10;"><span style="font-size:24px; text-shadow:0 0 5px #000;">❌</span></div>` : ''}
</div>`;
});
html += '</div>';
// 复用 agrDetailPopup 框架展示
document.body.appendChild(agrDetailPopup);
agrDetailPopup.innerHTML = html;
agrDetailPopup.style.display = 'block';
// 定位：寻找当前二级弹窗内的“🎮 捆绑包包含游戏”标题元素
const card = el.closest('.game-card') || el.closest('.popover-body');
const titleEl = card ? card.querySelector('.bundle-game-title') : null;
const btnRect = el.getBoundingClientRect();
let left = btnRect.right + 10;
let top;
if (titleEl) {
const titleRect = titleEl.getBoundingClientRect();
top = titleRect.top + window.scrollY; // 对齐到标题顶部
} else {
top = btnRect.top + window.scrollY; // Fallback 向下兼容
}
// 解决三级弹窗全量展示超长时的滚动条机制
const popupGrid = agrDetailPopup.querySelector('.agr-popup-grid');
if (popupGrid) {
// 留出内边距与视口限制
popupGrid.style.maxHeight = 'calc(100vh - 120px)';
popupGrid.style.overflowY = 'auto';
// 美化滚动条(由于在内联样式无法使用伪类，复用现有系统的 ::-webkit-scrollbar 规则或依赖通用浏览器默认)
}
// 边界检查
requestAnimationFrame(() => {
const popRect = agrDetailPopup.getBoundingClientRect();
// 处理右侧溢出：如果超出屏幕则放到左侧
if (left + popRect.width > window.innerWidth) {
left = btnRect.left - popRect.width - 10;
}
// 处理底部溢出：强行顶端对齐后，依然可能冲出底部。若底部超出视口，允许整体向上平移
if (top + popRect.height > window.innerHeight + window.scrollY) {
top = window.innerHeight + window.scrollY - popRect.height - 10;
}
// 极限防御
if (left < 10) left = 10;
if (top < window.scrollY + 10) top = window.scrollY + 10;
agrDetailPopup.style.left = left + 'px';
agrDetailPopup.style.top = top + 'px';
agrDetailPopup.style.marginLeft = '0';
});
}
function showAGRDetailPopup(el, groupAids, baseAids) {
if (event) event.stopPropagation();
let html = `<div class="agr-popup-title">🎮 差异地区包含 ${groupAids.length} 款游戏</div>`;
html += '<div class="agr-popup-grid">';
baseAids.forEach(appid => {
const aid = String(appid);
const headerUrl = bundleHeaderCache[aid] || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${aid}/header.jpg`;
const game = gameById[parseInt(aid)];
const gameName = game ? game.n : `AppID: ${aid}`;
const aidInt = parseInt(aid);
let statusClass = '';
let titleExtra = '';
if (userLibrary.owned.has(aidInt)) {
statusClass = 'bgc-owned'; titleExtra = ' [已拥有]';
} else if (userLibrary.familyMap.has(aidInt)) {
statusClass = 'bgc-family'; titleExtra = ' [家庭组]';
} else if (userLibrary.wishlist.has(aidInt)) {
statusClass = 'bgc-wishlist'; titleExtra = ' [愿望单]';
} else if (userLibrary.familyWishlistMap.has(aidInt)) {
statusClass = 'bgc-wishlist';
const owners = userLibrary.familyWishlistMap.get(aidInt);
titleExtra = ` [${owners ? owners[0] : ''}的愿望单]`;
} else if (favorites.has(aidInt)) {
statusClass = 'bgc-favorite'; titleExtra = ' [已收藏]';
}
// 判断该游戏是否在当前分组的数据中（不在则说明锁区）
const isMissing = !groupAids.includes(appid) && !groupAids.includes(aidInt) && !groupAids.includes(aid);
html += `<div class="bundle-game-card ${statusClass}" title="${escapeHtml(gameName + titleExtra)}" style="position:relative;"><img src="${escapeHtml(headerUrl)}" alt="${escapeHtml(gameName)}" loading="lazy" onerror="this.style.display='none'"><div class="bgc-name">${escapeHtml(gameName)}</div>
${isMissing ? `<div class="exclusion-mask" style="position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; justify-content:center; align-items:center; z-index:10;"><span style="font-size:16px; text-shadow:0 0 5px #000;">🔒锁区</span></div>` : ''}
</div>`;
});
html += '</div>';
document.body.appendChild(agrDetailPopup);
agrDetailPopup.innerHTML = html;
agrDetailPopup.style.display = 'block';
const rect = el.getBoundingClientRect();
let left = rect.right + 10;
let top = rect.top + window.scrollY;
requestAnimationFrame(() => {
const popRect = agrDetailPopup.getBoundingClientRect();
if (left + popRect.width > window.innerWidth) left = rect.left - popRect.width - 10;
if (top + popRect.height > window.innerHeight + window.scrollY) top = window.innerHeight + window.scrollY - popRect.height - 10;
if (left < 10) left = 10;
if (top < window.scrollY + 10) top = window.scrollY + 10;
agrDetailPopup.style.left = left + 'px';
agrDetailPopup.style.top = top + 'px';
agrDetailPopup.style.marginLeft = '0';
});
}
function closeAGRPopup() {
agrDetailPopup.style.display = 'none';
}
// ==================== [V1.1.2] 赠礼三级窗口逻辑 ====================
function showGiftingPopup(id, targetRegionCode, event, isBundle) {
event.stopPropagation();
event.preventDefault();
const popup = document.getElementById('giftingPopup');
if (!popup) return;
// 检查是否点击了同一个地区（如果是，则关闭弹窗）
const currentTargetId = popup.dataset.gameId;
const currentTargetRegion = popup.dataset.regionCode;
if (popup.style.display === 'block' && currentTargetId === String(id) && currentTargetRegion === targetRegionCode) {
popup.style.display = 'none';
popup.dataset.gameId = '';
popup.dataset.regionCode = '';
return;
}
// 记录新的打开状态
popup.dataset.gameId = String(id);
popup.dataset.regionCode = targetRegionCode;
// 获取商品数据
let item;
let prices = {}; // code -> { cny, lk }
if (isBundle) {
item = bundleByBid[id];
if (!item) return;
prices['cn'] = { cny: item.cp, lk: 0 };
Object.keys(item.rp || {}).forEach(k => {
prices[k] = { cny: item.rp[k].cny, lk: item.rp[k].lk || 0 };
});
} else {
item = gameById[id];
if (!item) return;
prices['cn'] = { cny: item.cp, lk: 0 };
if (item.ap) {
REGIONS_NON_CN.forEach((r, idx) => {
const pd = item.ap[idx];
if (pd && pd !== 0) prices[r.code] = { cny: pd[1], lk: 0 };
});
}
}
// 处理 sa_merged 南亚拆分计算
const targetCodes = targetRegionCode === 'sa_merged' ? ['pk', 'bd'] : [targetRegionCode];
let popupHTML = `<div class="gifting-popup-title">🎁 赠礼地区分析（仅供参考）</div>`;
targetCodes.forEach(tCode => {
if (targetCodes.length > 1) {
const tName = REGION_ABBR_MAP[REGIONS.find(r=>r.code===tCode)?.name] || tCode;
popupHTML += `<div style="font-size:13px; color:#fff; margin: 8px 0 4px; border-bottom: 1px dashed rgba(255,255,255,0.2);"><img src="${getFlagUrl(tCode === 'BD' ? 'bd' : tCode)}" style="width: 16px; height: 12px; border-radius: 2px; vertical-align: middle; margin-right: 4px;"> ${tName}</div>`;
}
popupHTML += generateGiftingAnalysisForRegion(prices, tCode, isBundle);
});
popup.innerHTML = popupHTML;
// 定位
const rect = event.currentTarget.getBoundingClientRect();
popup.style.display = 'block';
let top = rect.top + window.scrollY;
let left = rect.right + 10;
const popoverWidth = popup.offsetWidth || 380;
if (left + popoverWidth > window.innerWidth) {
left = rect.left - popoverWidth - 10;
}
if (left < 10) left = 10;
const maxTop = window.scrollY + window.innerHeight - popup.offsetHeight - 10;
if (top > maxTop) top = maxTop;
if (top < window.scrollY + 10) top = window.scrollY + 10;
popup.style.top = top + 'px';
popup.style.left = left + 'px';
}
// 内部：生成单个目标区的分析 HTML
function generateGiftingAnalysisForRegion(prices, targetRegionCode, isBundle) {
const targetData = prices[targetRegionCode];
const rFullName = BUNDLE_REGION_NAMES[targetRegionCode] || REGIONS.find(r=>r.code===targetRegionCode)?.name || targetRegionCode;
const targetName = REGION_ABBR_MAP[rFullName] || rFullName;
if (!targetData || targetData.cny === null || targetData.lk > 0) {
return `<div class="gifting-popup-section"><div class="gift-status-red">🚫 目标区（${targetName}）暂无价格或部分锁区，无法分析。</div></div>`;
}
const targetPrice = targetData.cny;
// 评估函数
const evaluateGift = (baseP, targetP) => {
if (baseP === null || targetP === null) return 'red';
if (baseP > targetP) return 'green';
const diffRate = (targetP - baseP) / baseP;
if (diffRate <= 0.12) return 'green';
if (diffRate <= 0.15) return 'yellow';
return 'red';
};
const formatGiftStatusMsg = (status) => {
if (status === 'green') return '<span class="gift-status-green">✔️ 大概率可送</span>';
if (status === 'yellow') return '<span class="gift-status-yellow">⚠️ 可能可送</span>';
return '<span class="gift-status-red">❌ 无法送礼</span>';
};
// ========== 好友分析 ==========
let friendHtml = '';
if (friendCodes && friendCodes.length > 0) {
const mainAccount = friendCodes[0];
const mainRegion = mainAccount.region || 'cn';
const mainPriceData = prices[mainRegion];
friendHtml += `<div class="gifting-popup-section"><div class="gifting-popup-subtitle">👥 好友互动分析 (以 ${REGION_ABBR_MAP[REGIONS.find(r=>r.code===mainRegion)?.name] || mainRegion} 基准价 ¥${mainPriceData ? mainPriceData.cny.toFixed(2) : '-'} 计算)</div>`;
// 主账号做赠礼方给其他人 (针对当前 targetRegionCode 是否属于好友)
// 简化：直接列出主账号能给列表里哪些人送，哪些人能给主账号送
let canGive = [];
let canReceiveFrom = [];
friendCodes.slice(1).forEach(friend => {
const fRegion = friend.region || 'cn';
const fPriceData = prices[fRegion];
if (!fPriceData || fPriceData.cny === null || fPriceData.lk > 0) return;
const pToF = evaluateGift(mainPriceData ? mainPriceData.cny : null, fPriceData.cny);
const pFromF = evaluateGift(fPriceData.cny, mainPriceData ? mainPriceData.cny : null);
const fAvatar = friend.avatar ? `<img src="${friend.avatar}" class="gifting-friend-avatar">` : '👤';
if (pToF !== 'red') {
canGive.push(`<span class="gifting-friend-item ${pToF === 'green'?'gift-status-green':'gift-status-yellow'}">${fAvatar} ${escapeHtml(friend.name)}(${REGION_ABBR_MAP[REGIONS.find(r=>r.code===fRegion)?.name] || fRegion})</span>`);
}
if (pFromF !== 'red') {
canReceiveFrom.push(`<span class="gifting-friend-item ${pFromF === 'green'?'gift-status-green':'gift-status-yellow'}">${fAvatar} ${escapeHtml(friend.name)}(${REGION_ABBR_MAP[REGIONS.find(r=>r.code===fRegion)?.name] || fRegion})</span>`);
}
});
const mainAvatar = mainAccount.avatar ? `<img src="${mainAccount.avatar}" class="gifting-friend-avatar">` : '👤';
friendHtml += `<div class="gifting-row" style="color:#d4d4d4;">
${mainAvatar} ${escapeHtml(mainAccount.name)} <span style="color:#8f98a0;">送礼给 ➔</span> ${canGive.length ? canGive.join(' ') : '<span style="color:#8f98a0;">(无合规对象)</span>'}
</div>`;
friendHtml += `<div class="gifting-row" style="color:#d4d4d4;">
${mainAvatar} ${escapeHtml(mainAccount.name)} <span style="color:#8f98a0;">接收自 ⬅</span> ${canReceiveFrom.length ? canReceiveFrom.join(' ') : '<span style="color:#8f98a0;">(无合规对象)</span>'}
</div>`;
friendHtml += `</div>`;
}
// ========== 全局收发分析 (以 target 视角) ==========
// 当前目标区作为赠发方 (Give to) -> Base = targetPrice, Target = Other
const giveGreen = [], giveYellow = [], giveRed = [];
// 当前目标区作为接收方 (Receive from) -> Base = Other, Target = targetPrice
const recvGreen = [], recvYellow = [];
Object.keys(prices).forEach(rCode => {
const rData = prices[rCode];
const rName = REGION_ABBR_MAP[REGIONS.find(r=>r.code===rCode)?.name] || rCode;
const rHtml = `<span class="gifting-region-item"><img src="${getFlagUrl(rCode === 'BD' ? 'bd' : rCode)}" style="width: 16px; height: 12px; border-radius: 2px; vertical-align: middle; margin-right: 4px;"> ${rName}</span>`;
if (!rData || rData.cny === null || rData.lk > 0) {
giveRed.push(rHtml);
return;
}
// Give
const giveStatus = evaluateGift(targetPrice, rData.cny);
if (giveStatus === 'green') giveGreen.push(rHtml);
else if (giveStatus === 'yellow') giveYellow.push(rHtml);
else giveRed.push(rHtml);
// Receive
const recvStatus = evaluateGift(rData.cny, targetPrice);
if (recvStatus === 'green') recvGreen.push(rHtml);
else if (recvStatus === 'yellow') recvYellow.push(rHtml);
});
let globalHtml = `
<div class="gifting-popup-section"><div class="gifting-popup-subtitle">🌍 全域送礼能力 (作为发起方: ${targetName})</div><div class="gifting-row"><span class="gift-status-green" style="min-width:40px;">可送：</span><div class="gifting-region-list gift-status-green">${giveGreen.join('') || '-'}</div></div><div class="gifting-row"><span class="gift-status-yellow" style="min-width:40px;">风险：</span><div class="gifting-region-list gift-status-yellow">${giveYellow.join('') || '-'}</div></div><div class="gifting-row"><span class="gift-status-red" style="min-width:40px;">不可：</span><div class="gifting-region-list gift-status-red">${giveRed.join('') || '-'}</div></div></div><div class="gifting-popup-section"><div class="gifting-popup-subtitle">🌍 全域收礼能力 (作为接收方: ${targetName})</div><div class="gifting-row"><span class="gift-status-green" style="min-width:40px;">可收：</span><div class="gifting-region-list gift-status-green">${recvGreen.join('') || '-'}</div></div><div class="gifting-row"><span class="gift-status-yellow" style="min-width:40px;">风险：</span><div class="gifting-region-list gift-status-yellow">${recvYellow.join('') || '-'}</div></div></div>
`;
return friendHtml + globalHtml;
}
// ==================== [V7.3] 捆绑包计算器 ====================
const bundleCalcPopup = document.getElementById('bundleCalcPopup');
function openBundleCalculator(event, bid) {
if (event) {
event.stopPropagation();
event.preventDefault();
}
if (bundleCalcPopup.style.display === 'block' && currentCalcBid === bid) {
closeBundleCalculator();
return;
}
const bundle = bundleByBid[bid];
if (!bundle) return;
currentCalcBid = bid;
calcExcludedApps.clear();
// 自动排除规则
if (bundle.mps === 0 && bundle.bl) {
bundle.bl.forEach(aid => {
const aidInt = parseInt(aid);
const game = gameById[aidInt];
if (!game || userLibrary.owned.has(aidInt)) {
calcExcludedApps.add(aidInt);
}
});
}
const select = document.getElementById('bundleCalcRegionSelect');
select.innerHTML = '';
const rp = bundle.rp || {};
let firstRegion = null;
let optionsHTML = '';
if (rp['cn']) {
firstRegion = 'cn';
optionsHTML += `<option value="cn">🇨🇳 中国</option>`;
}
const nonCnRegions = Object.keys(rp).filter(r => r !== 'cn');
nonCnRegions.forEach(rcode => {
const regionName = BUNDLE_REGION_NAMES[rcode] || rcode;
optionsHTML += `<option value="${rcode}">${regionName}</option>`;
if (!firstRegion) firstRegion = rcode;
});
select.innerHTML = optionsHTML;
clearCalcResult();
document.body.appendChild(bundleCalcPopup);
bundleCalcPopup.style.display = 'block';
const rect = event ? event.currentTarget.getBoundingClientRect() : document.getElementById('bundleCalcBtnContainer').getBoundingClientRect();
let left = rect.right + 10;
let top = rect.top + window.scrollY;
requestAnimationFrame(() => {
const popRect = bundleCalcPopup.getBoundingClientRect();
if (left + popRect.width > window.innerWidth) left = rect.left - popRect.width - 10;
if (top + popRect.height > window.innerHeight + window.scrollY) top = window.innerHeight + window.scrollY - popRect.height - 10;
if (left < 10) left = 10;
if (top < window.scrollY + 10) top = window.scrollY + 10;
bundleCalcPopup.style.left = left + 'px';
bundleCalcPopup.style.top = top + 'px';
if (firstRegion) {
select.value = firstRegion;
onCalcRegionChange();
}
});
}
function closeBundleCalculator() {
if (bundleCalcPopup) bundleCalcPopup.style.display = 'none';
closeAGRPopup();
}
function onCalcRegionChange() {
clearCalcResult();
const bid = currentCalcBid;
const regionCode = document.getElementById('bundleCalcRegionSelect').value;
// 依赖于计算器弹窗自身作为锚点展示附带的所有游戏弹窗
showAllBundleGamesPopup(null, bundleCalcPopup, bid, regionCode);
}
function clearCalcResult() {
document.getElementById('bundleCalcForeignPrice').textContent = '-';
document.getElementById('bundleCalcCnyPrice').textContent = '-';
}
function toggleExcludeGame(event, cardEl, aidInt) {
if (event) {
event.stopPropagation();
event.preventDefault();
}
if (calcExcludedApps.has(aidInt)) {
calcExcludedApps.delete(aidInt);
const mask = cardEl.querySelector('.exclusion-mask');
if (mask) mask.remove();
} else {
calcExcludedApps.add(aidInt);
cardEl.insertAdjacentHTML('beforeend', `<div class="exclusion-mask" style="position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(231,76,60,0.6); display:flex; justify-content:center; align-items:center; z-index:10;"><span style="font-size:24px; text-shadow:0 0 5px #000;">❌</span></div>`);
}
clearCalcResult();
}
function calculateBundlePrice() {
const bid = currentCalcBid;
const bundle = bundleByBid[bid];
const regionCode = document.getElementById('bundleCalcRegionSelect').value;
if (!bundle || !regionCode) return;
const rpData = bundle.rp[regionCode];
if (!rpData || !rpData.aids) {
alert("该地区无可用价格信息");
return;
}
if (calcExcludedApps.size === 0) {
const bundlePriceStr = (rpData.p || '').replace(/\(ID:\d+\)/i, '').trim();
const officialCny = rpData.cny || 0;
document.getElementById('bundleCalcForeignPrice').textContent = bundlePriceStr || '暂无价格';
if (officialCny === 0 && !bundlePriceStr) {
document.getElementById('bundleCalcCnyPrice').innerHTML = `<span style="color:#e74c3c;">¥ 0.00</span>`;
} else {
document.getElementById('bundleCalcCnyPrice').textContent = '¥ ' + officialCny.toFixed(2);
}
return;
}
const baseDiscountStr = rpData.bd || 0;
const baseDiscount = parseFloat(baseDiscountStr) / 100;
let totalCny = 0;
let totalForeignNum = 0;
let validCount = 0;
rpData.aids.forEach(aid => {
const aidInt = parseInt(aid);
if (!calcExcludedApps.has(aidInt)) {
const game = gameById[aidInt];
if (game && game.ap) {
let priceIdx = -1;
if (regionCode !== 'cn') {
const nonCnCodes = JS_CC_LIST.filter(c => c[0] !== 'cn').map(c => c[0]);
priceIdx = nonCnCodes.indexOf(regionCode);
}
let gameCny = null;
if (regionCode === 'cn') {
gameCny = game.cp;
} else if (priceIdx >= 0 && priceIdx < game.ap.length) {
const apItem = game.ap[priceIdx];
if (Array.isArray(apItem) && apItem.length >= 2) {
gameCny = apItem[1];
}
}
if (gameCny !== null) {
totalCny += gameCny;
validCount++;
}
}
}
});
// 汇率逆推：循环结束后，通过汇率将totalCny逆推为外币总价
if (regionCode === 'cn') {
totalForeignNum = totalCny;
} else {
const ccEntry = JS_CC_LIST.find(c => c[0] === regionCode);
const currencyCode = ccEntry ? ccEntry[2] : null;
const rate = currencyCode ? (EXCHANGE_RATES[currencyCode] || 0) : 0;
totalForeignNum = rate > 0 ? totalCny / rate : 0;
}
if (validCount === 0) {
document.getElementById('bundleCalcForeignPrice').textContent = "无有效商品";
document.getElementById('bundleCalcCnyPrice').innerHTML = `<span style="color:#e74c3c;">¥ 0.00</span>`;
return;
}
// 提取外币单位前后缀
const bundlePriceStr = rpData.p || '';
let foreignPrefix = '';
let foreignSuffix = '';
const match = bundlePriceStr.replace(/\(ID:\d+\)/i, '').trim().match(/^([^\d]*)((?:\d+[.,\s]*)+)([^\d]*)$/);
if (match) {
foreignPrefix = match[1];
foreignSuffix = match[3];
} else {
const curr = JS_CC_LIST.find(c => c[0] === regionCode)?.[2] || 'USD';
foreignSuffix = ' ' + curr;
}
const finalForeign = totalForeignNum * (1 - baseDiscount);
const finalCny = totalCny * (1 - baseDiscount);
document.getElementById('bundleCalcForeignPrice').textContent = foreignPrefix + finalForeign.toFixed(2) + foreignSuffix;
document.getElementById('bundleCalcCnyPrice').textContent = '¥ ' + finalCny.toFixed(2);
}
// ==================== 初始化 ====================
try {
initRegionMenu();
updateStats();
renderBatch();
} catch (error) {
console.error("页面核心初始化失败:", error);
// 强制隐藏加载遮罩，防止卡死
const loaderEl = document.getElementById('loader');
if (loaderEl) loaderEl.style.display = 'none';
// 插入一条错误提示
const errorMsg = document.createElement('div');
errorMsg.style.cssText = 'background: rgba(231, 76, 60, 0.9); color: white; padding: 10px; text-align: center; position: fixed; top: 0; width: 100%; z-index: 10000; font-size: 14px;';
errorMsg.innerHTML = '⚠️ 页面渲染发生错误，部分功能可能受限。请打开控制台(F12)查看详情。';
document.body.prepend(errorMsg);
}
// ==================== [购物车] 高级购物车与无感结算系统 ====================
// --- 状态管理 ---
function updateCartBadge() {
const btn = document.getElementById('floatingCartBtn');
const badge = document.getElementById('cartBtnBadge');
if (!btn || !badge) return;
const count = cartSet.size;
if (count === 0) {
btn.style.display = 'none';
} else {
btn.style.display = 'block';
badge.textContent = count > 99 ? '99+' : count;
}
}
// --- 悬浮按钮拖拽逻辑（PC + 移动端，5px 阈值区分点击与拖拽）---
function initCartBtnDrag() {
const btn = document.getElementById('floatingCartBtn');
if (!btn) return;
let isDragging = false;
let startX, startY, startRight, startBottom;
const DRAG_THRESHOLD = 5;
function onPointerDown(ex, ey) {
isDragging = false;
startX = ex;
startY = ey;
const rect = btn.getBoundingClientRect();
startRight = window.innerWidth - rect.right;
startBottom = window.innerHeight - rect.bottom;
}
function onPointerMove(ex, ey) {
const dx = Math.abs(ex - startX);
const dy = Math.abs(ey - startY);
if (!isDragging && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
isDragging = true;
btn.classList.add('dragging');
}
if (isDragging) {
const newRight = startRight - (ex - startX);
const newBottom = startBottom - (ey - startY);
btn.style.right = Math.max(8, Math.min(newRight, window.innerWidth - 64)) + 'px';
btn.style.bottom = Math.max(8, Math.min(newBottom, window.innerHeight - 64)) + 'px';
btn.style.left = 'auto';
btn.style.top = 'auto';
}
}
function onPointerUp() {
btn.classList.remove('dragging');
const wasDragging = isDragging;
isDragging = false;
return !wasDragging; // true = 判定为点击
}
// PC 鼠标
btn.addEventListener('mousedown', function(e) {
e.preventDefault();
onPointerDown(e.clientX, e.clientY);
function onMouseMove(e) { onPointerMove(e.clientX, e.clientY); }
function onMouseUp(e) {
document.removeEventListener('mousemove', onMouseMove);
document.removeEventListener('mouseup', onMouseUp);
if (onPointerUp()) openCartModal();
}
document.addEventListener('mousemove', onMouseMove);
document.addEventListener('mouseup', onMouseUp);
});
// 移动端 Touch
btn.addEventListener('touchstart', function(e) {
const t = e.touches[0];
onPointerDown(t.clientX, t.clientY);
}, { passive: true });
btn.addEventListener('touchmove', function(e) {
e.preventDefault();
const t = e.touches[0];
onPointerMove(t.clientX, t.clientY);
}, { passive: false });
btn.addEventListener('touchend', function(e) {
if (onPointerUp()) openCartModal();
});
}
// --- 切换购物车（加入/移出）---
function toggleCartItem(event, appid) {
event.stopPropagation();
event.preventDefault();
if (userLibrary.owned.has(appid)) {
alert('已拥有的游戏无法加入购物车');
return;
}
const game = displayData.find(g => g.id === appid);
if (!game) return;
// 获取主账号地区
const mainRegion = (typeof friendCodes !== 'undefined' && friendCodes.length > 0)
? (friendCodes[0].region || 'cn')
: 'cn';
// 解析该游戏在主账号地区下的数据
let regionSubId = null;
let displayPrice = null;
let priceCny = null;
let isLocked = false;
if (mainRegion === 'cn') {
priceCny = game.cp;
displayPrice = priceCny != null ? '¥' + priceCny.toFixed(2) : null;
isLocked = priceCny == null;
regionSubId = game.sid || null;
} else {
const nonCnCodes = (typeof JS_CC_LIST !== 'undefined' ? JS_CC_LIST : []).filter(c => c[0] !== 'cn').map(c => c[0]);
const regionIdx = nonCnCodes.indexOf(mainRegion);
if (regionIdx >= 0 && game.ap && game.ap[regionIdx] !== undefined) {
const pd = game.ap[regionIdx];
if (pd === 0) {
isLocked = true;
} else {
displayPrice = pd[0];
priceCny = pd[1];
regionSubId = pd[2] || null;
}
} else {
isLocked = true;
}
}
// 查找卡片 DOM
const cardEl = document.querySelector(`.game-card[data-idx="${game.i}"]`);
const overlayEl = cardEl ? cardEl.querySelector('.cart-hover-overlay') : null;
if (cartSet.has(appid)) {
// 移出购物车
cartSet.delete(appid);
if (cardEl) {
cardEl.classList.remove('in-cart');
const cartLabel = cardEl.querySelector('.status-badge.cart-badge-label');
if (cartLabel) cartLabel.remove();
// 恢复原本的 family 或 wishlist
if (userLibrary.familyMap.has(appid) && userLibrary.familyMap.get(appid).length > 0) {
cardEl.classList.add('family');
const coverWrapper = cardEl.querySelector('.cover-wrapper');
if (coverWrapper && !coverWrapper.querySelector('.status-badge')) {
const familyOwners = userLibrary.familyMap.get(appid) || [];
const badge = document.createElement('div');
badge.className = 'status-badge family';
badge.setAttribute('data-type', 'family');
badge.setAttribute('data-owners', JSON.stringify(familyOwners));
badge.onmouseenter = function(e) { showAccountTooltip(e, this); };
badge.onmouseleave = hideAccountTooltip;
badge.innerHTML = '家庭共享<span style="font-size: 9px; color: rgba(255,255,255,0.75); margin-left: 2px; font-weight: normal;">?</span>';
coverWrapper.insertBefore(badge, coverWrapper.firstChild);
}
} else {
const isW = userLibrary.wishlist.has(appid);
const fW = userLibrary.familyWishlistMap.get(appid) || [];
if (isW || fW.length > 0) {
cardEl.classList.add('wishlist');
const coverWrapper = cardEl.querySelector('.cover-wrapper');
if (coverWrapper && !coverWrapper.querySelector('.status-badge')) {
const allO = [];
if (isW) allO.push('我');
fW.forEach(n => allO.push(n));
const ownersStr = JSON.stringify(allO);
const displayText = allO.length === 1
? '愿望单'
: '愿望单 +' + (allO.length - 1);
const badge = document.createElement('div');
badge.className = 'status-badge wishlist';
badge.setAttribute('data-type', 'wishlist');
badge.setAttribute('data-owners', ownersStr);
badge.onmouseenter = function(e) { showAccountTooltip(e, this); };
badge.onmouseleave = hideAccountTooltip;
badge.innerHTML = escapeHtml(displayText) + '<span style="font-size: 9px; color: rgba(27,40,56,0.65); margin-left: 2px; font-weight: normal;">?</span>';
coverWrapper.insertBefore(badge, coverWrapper.firstChild);
}
}
}
}
if (overlayEl) overlayEl.textContent = '加入购物车';
} else {
// 加入购物车
cartSet.set(appid, {
name: game.n,
regionSubId: regionSubId,
displayPrice: displayPrice,
priceCny: priceCny,
coverUrl: getCoverUrl(game),
discount: game.d || '',
isLocked: isLocked
});
if (cardEl) {
cardEl.classList.remove('family', 'wishlist');
cardEl.classList.add('in-cart');
const oldBadge = cardEl.querySelector('.cover-wrapper .status-badge');
if (oldBadge) oldBadge.remove();
if (!cardEl.querySelector('.status-badge.cart-badge-label')) {
const coverWrapper = cardEl.querySelector('.cover-wrapper');
if (coverWrapper) {
const badge = document.createElement('div');
badge.className = 'status-badge cart-badge-label';
badge.textContent = '🛒购物车中';
coverWrapper.insertBefore(badge, coverWrapper.firstChild);
}
}
}
if (overlayEl) overlayEl.textContent = '移除购物车';
}
updateCartBadge();
}
// --- 渲染购物车弹窗内容 ---
function renderCartModal() {
const mainAccount = (typeof friendCodes !== 'undefined' && friendCodes.length > 0)
? friendCodes[0] : null;
const mainRegion = mainAccount ? (mainAccount.region || 'cn') : 'cn';
// 头部账号信息
const accountBarEl = document.getElementById('cartAccountBar');
if (accountBarEl && mainAccount) {
const flagUrl = mainAccount.region ? getFlagUrl(mainAccount.region) : '';
const regionName = REGION_ABBR_MAP[REGIONS.find(r => r.code === mainAccount.region)?.name] || mainAccount.region || 'CN';
accountBarEl.innerHTML = `
${mainAccount.avatar ? `<img src="${mainAccount.avatar}" class="cart-avatar" onerror="this.style.display='none'">` : '👤'}
<span class="cart-account-name">${escapeHtml(mainAccount.name || '主账号')}</span>
${flagUrl ? `<img src="${flagUrl}" class="cart-account-flag" onerror="this.style.display='none'">` : ''}
<span style="color:#c6d4df;">${escapeHtml(regionName)}</span>
`;
}
// 左侧商品列表
const leftEl = document.getElementById('cartItemList');
if (!leftEl) return;
if (cartSet.size === 0) {
leftEl.innerHTML = '<div class="cart-empty-tip">购物车是空的，<br>点击游戏标题可加入购物车 🛒</div>';
document.getElementById('cartTotalCny').textContent = '¥0.00';
document.getElementById('cartTotalNote').textContent = '暂无商品';
return;
}
let itemsHTML = '';
let totalCny = 0;
let lockedCount = 0;
cartSet.forEach((info, appid) => {
const isLocked = info.isLocked;
if (isLocked) {
lockedCount++;
} else {
totalCny += info.priceCny || 0;
}
const lockedMaskHTML = isLocked
? `<div class="cart-cover-locked-mask">锁区</div>` : '';
const priceHTML = isLocked
? `<div class="cart-price-locked">该地区无法购买</div>`
: `<div class="cart-price-current">${escapeHtml(info.displayPrice || '')} (¥${(info.priceCny||0).toFixed(2)})</div>`;
const discountHTML = info.discount && info.discount !== '0'
? `<div class="cart-item-discount">${escapeHtml(info.discount)}</div>` : '';
itemsHTML += `
<div class="cart-item" data-appid="${appid}"><div class="cart-item-cover-wrap"><img src="${escapeHtml(info.coverUrl)}" onerror="this.style.display='none'">
${lockedMaskHTML}
</div><div class="cart-item-info"><div class="cart-item-name" title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</div>
${discountHTML}
</div><div class="cart-item-price">${priceHTML}</div><button class="cart-item-remove" onclick="removeCartItem(event,${appid})">移除</button></div>
`;
});
leftEl.innerHTML = itemsHTML;
// 右侧总价
const totalCnyEl = document.getElementById('cartTotalCny');
const totalForeignEl = document.getElementById('cartTotalForeign');
const noteEl = document.getElementById('cartTotalNote');
if (totalCnyEl) {
totalCnyEl.textContent = mainRegion === 'cn' ? '' : ('≈ ¥' + totalCny.toFixed(2));
totalCnyEl.style.display = mainRegion === 'cn' ? 'none' : 'block';
}
if (totalForeignEl) {
if (mainRegion === 'cn') {
totalForeignEl.textContent = '¥' + totalCny.toFixed(2);
} else {
// 汇率逆推计算外币总额
let totalForeignNum = 0;
let currencyCode = '';
const ccEntry = JS_CC_LIST.find(c => c[0] === mainRegion);
if (ccEntry) {
currencyCode = ccEntry[2]; // 索引 2 才是货币代码
const rate = EXCHANGE_RATES[currencyCode] || 0;
if (rate > 0) {
totalForeignNum = totalCny / rate;
}
}
// 智能抹除小数：对齐后端逻辑，特定货币强制无小数
const noDecimalCurrencies = ['VND', 'KZT', 'CLP', 'IDR', 'UAH', 'JPY', 'KRW'];
const formatOpts = noDecimalCurrencies.includes(currencyCode) 
? { minimumFractionDigits: 0, maximumFractionDigits: 0 } 
: { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const priceStr = totalForeignNum.toLocaleString('en-US', formatOpts);
const symbols = STEAM_CURRENCY_SYMBOLS[currencyCode] || ['', ' ' + currencyCode];
totalForeignEl.textContent = symbols[0] + priceStr + symbols[1];
}
}
if (noteEl) {
const buyable = cartSet.size - lockedCount;
noteEl.textContent = `共 ${cartSet.size} 件商品，${buyable} 件可结算${lockedCount > 0 ? `（${lockedCount} 件锁区不计入）` : ''}`;
}
}
// --- 从购物车列表移除单个 ---
function removeCartItem(event, appid) {
event.stopPropagation();
event.preventDefault();
if (!cartSet.has(appid)) return;
cartSet.delete(appid);
// 更新对应卡片 DOM
const game = displayData.find(g => g.id === appid);
if (game) {
const cardEl = document.querySelector(`.game-card[data-idx="${game.i}"]`);
if (cardEl) {
cardEl.classList.remove('in-cart');
const cartLabel = cardEl.querySelector('.status-badge.cart-badge-label');
if (cartLabel) cartLabel.remove();
const overlayEl = cardEl.querySelector('.cart-hover-overlay');
if (overlayEl) overlayEl.textContent = '加入购物车';
}
}
updateCartBadge();
renderCartModal();
}
// --- 打开购物车弹窗 ---
function openCartModal() {
const overlay = document.getElementById('cartModalOverlay');
if (!overlay) return;
renderCartModal();
overlay.classList.add('show');
// 锁定背景滚动
document.body.style.overflow = 'hidden';
}
function closeCartModal() {
const overlay = document.getElementById('cartModalOverlay');
if (overlay) {
overlay.classList.remove('show');
// 恢复背景滚动
document.body.style.overflow = '';
}
}
// --- 结算逻辑 ---
function checkoutCart() {
// 收集所有未锁区的 SubID
const subIds = [];
cartSet.forEach((info, appid) => {
if (!info.isLocked && info.regionSubId) {
subIds.push(info.regionSubId);
}
});
if (subIds.length === 0) {
alert('当前购物车内无可结算的商品（所有商品在该地区均锁区或缺少 SubID）');
return;
}
const subIdsStr = subIds.join(',');
const btn = document.getElementById('cartCheckoutBtn');
if (btn) btn.classList.add('loading');
// 派发事件给油猴脚本
window.dispatchEvent(new CustomEvent('STEAM_ADD_TO_CART_REQUEST', {
detail: { subids: subIdsStr }
}));
}
// 监听油猴的结算完成回调
window.addEventListener('STEAM_ADD_TO_CART_RESPONSE', function () {
const btn = document.getElementById('cartCheckoutBtn');
if (btn) btn.classList.remove('loading');
// 跳转到 Steam 购物车
window.open('https://store.steampowered.com/cart/', '_blank');
// 延迟弹窗，让用户确认是否清空
setTimeout(() => {
if (confirm('已发送至 Steam 购物车！\n是否清空当前的本地购物车？')) {
clearAllCartItems();
closeCartModal();
}
}, 300);
});
// --- 手动清空购物车（带弹窗）---
function promptClearCart() {
if (cartSet.size === 0) return;
if (confirm('确定要清空本地购物车里的所有游戏吗？')) {
clearAllCartItems();
renderCartModal();
}
}
// --- 清空所有购物车状态 ---
function clearAllCartItems() {
cartSet.forEach((info, appid) => {
const game = displayData.find(g => g.id === appid);
if (game) {
const cardEl = document.querySelector(`.game-card[data-idx="${game.i}"]`);
if (cardEl) {
cardEl.classList.remove('in-cart');
const cartLabel = cardEl.querySelector('.status-badge.cart-badge-label');
if (cartLabel) cartLabel.remove();
const overlayEl = cardEl.querySelector('.cart-hover-overlay');
if (overlayEl) overlayEl.textContent = '加入购物车';
}
}
});
cartSet.clear();
updateCartBadge();
}
// --- 初始化悬浮按钮和弹窗 ---
(function initCartUI() {
// 注入悬浮按钮
const cartBtn = document.createElement('div');
cartBtn.id = 'floatingCartBtn';
cartBtn.className = 'floating-cart-btn';
cartBtn.innerHTML = '🛒<span class="cart-badge" id="cartBtnBadge">0</span>';
document.body.appendChild(cartBtn);
// 注入购物车弹窗遮罩
const overlay = document.createElement('div');
overlay.id = 'cartModalOverlay';
overlay.className = 'cart-modal-overlay';
overlay.innerHTML = `
<div class="cart-modal"><div class="cart-modal-header"><h3>🛒 购物车</h3><button class="cart-modal-close" onclick="closeCartModal()">✕</button></div><div class="cart-account-bar" id="cartAccountBar"><span style="color:#536878;">未设置主账号</span></div><div class="cart-modal-body"><div class="cart-left" id="cartItemList"><div class="cart-empty-tip">购物车是空的</div></div><div class="cart-right"><div class="cart-total-label">预计总额</div><div class="cart-total-foreign" id="cartTotalForeign">-</div><div class="cart-total-cny" id="cartTotalCny">¥0.00</div><div class="cart-total-note" id="cartTotalNote" style="margin-bottom: 8px;">暂无商品</div><div class="cart-clear-text-btn" onclick="promptClearCart()">清空购物车</div><button class="cart-checkout-btn" id="cartCheckoutBtn" onclick="checkoutCart()">
去 Steam 结算
</button></div></div></div>
`;
overlay.addEventListener('click', function(e) {
if (e.target === overlay) closeCartModal();
});
document.body.appendChild(overlay);
// 初始化拖拽
initCartBtnDrag();
})();
