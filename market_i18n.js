/* Shared UI translations. Keep API keys, filter values and exported evidence unchanged. */
(() => {
  'use strict';
  const messages = {
    '★ 特别关注': '★ Watchlist', '☆ 特别关注': '☆ Watch item', '★ 已关注': '★ Watching',
    '关注想买的商品，新的在售报价会单独提醒；装备也支持，不要求达到低价提醒条件。': 'Watch items you want to buy and get separate alerts for new listings. Equipment is supported; bargain criteria do not apply.',
    '关注25/30级弓与弩': 'Watch level 25 / 30 bows & crossbows',
    '添加商品': 'Add an item', '添加关注': 'Add to watchlist',
    '提醒特别关注商品的新报价': 'Alert me to new watched-item listings',
    '关注保存在当前浏览器。网页打开时接收新报价提醒；已有报价会列出，重复采集同一报价不会重复弹窗。价格与库存请到摊位核对。': 'Watches are saved in this browser. Keep the page open for new-listing alerts. Existing quotes are listed; repeat captures of the same offer do not repeat notifications. Verify price and stock in the shop.',
    '最高单价': 'Max. unit price', '最高接受单价': 'Maximum accepted unit price', '不限': 'No limit',
    '报价商品': 'Quoted item', '全部关注商品': 'All watched items',
    '取消关注': 'Remove watch', '关注商品': 'Watched items', '符合条件的在售观察': 'Matching listing observations',
    '还没有特别关注的商品。可搜索添加，或使用弓弩预设。': 'No watched items yet. Search to add an item or use the bow and crossbow preset.',
    '暂无符合关注条件的在售观察；继续采集或等待共享市场更新。': 'No matching listing observations. Continue collecting or wait for shared-market updates.',
    '发现特别关注商品': 'Watched items found', '查看特别关注': 'View watchlist', '件': 'item',
    '浏览器无法保存关注列表，请检查存储设置。': 'The browser could not save your watches. Check storage settings.',
    '最多关注100种商品。': 'You can watch up to 100 items.',
    '报价较多，当前显示最近200条观察。': 'Many quotes are available; showing the latest 200 observations.',
    '报价按最新摊位快照更新；请到摊位核对库存与价格。': 'Quotes use the latest shop snapshots. Verify stock and price in the shop.',
    '特别关注暂无法更新，保留上次报价。': 'Watchlist updates are unavailable; previous quotes are retained.',
    '图鉴搜索暂不可用，可从商品列表添加关注。': 'Catalogue search is unavailable. You can add watches from the item list.',
    '请从搜索建议中选择具体商品。': 'Choose a specific item from the search suggestions.',
    '枫叶市集': 'Maple Market',
    '枫叶市集 · 商品价格库': 'Maple Market · Price Database',
    '枫叶市集 · 成员登录': 'Maple Market · Member Sign In',
    '背包与摆摊 · 枫叶市集': 'Inventory & Selling · Maple Market',
    '枫叶市集 · 背包与摆摊': 'Maple Market · Inventory & Selling',
    '商品价格库': 'Price Database', '低价提醒': 'Deal Alerts', '背包与摆摊': 'Inventory & Selling',
    '正在检测采集连接…': 'Checking the collector connection…',
    '正在检测连接状态…': 'Checking connection status…',
    '先了解价格，再去逛摊。': 'Know the prices before you browse.',
    '按商品整理手动逛摊的报价，找到价格区间与市场参照。': 'Compare quotes from shops you visited and explore price ranges.',
    '导出市场数据 ↗': 'Export market data ↗', '摊位时间范围': 'Quote window',
    '近 72 小时': 'Last 72 hours', '近 72h': 'Last 72h', '全部': 'All',
    '市场概览': 'Market overview', '已收录商品': 'Items recorded',
    '不同物品 ID，合并重复访问': 'Unique item IDs; repeat visits merged',
    '报价挂单': 'Quoted listings', '每个摊位取最新快照': 'Latest snapshot from each shop',
    '摊位': 'Shops', '仅覆盖实际访问过的摊位': 'Only shops actually visited',
    '售罄记录': 'Sold-out observations', '发现售光，按此前报价计价': 'Sold-out observations at the previous ask',
    '逛到便宜商品，实时提醒；随时回看最近发现。': 'Get alerts as you find deals and revisit recent discoveries.',
    '低于其他摊位下四分位 · 至少8个报价摊位 · 参考在售挂单和库存数量 · 按快卖价扣3%手续费后估算空间至少15%。装备暂不参与转卖提醒。': 'Below other shops’ lower quartile · At least 8 quoted shops · Uses listings and stock · Estimated margin of at least 15% at the quick-sale price after a 3% fee. Equipment is excluded.',
    '查看': 'Show', '最近发现': 'Recent discoveries', '仅最近两分钟': 'Last two minutes only',
    '提醒新发现的低价商品': 'Alert me to newly discovered deals', '网页内弹窗': 'In-page notifications',
    '仅提醒本机最近采集的商品；在售数量代表供给，不代表成交量。': 'Alerts use recent local observations. Listed quantity measures supply, not sales.',
    '报价单位：金币 / 件 · 装备区间可能包含不同属性，详见商品页。': 'Prices: mesos per item · Equipment ranges may include different stats; see item details.',
    '每 5 秒更新': 'Updates every 5 seconds', '商品分类': 'Item categories',
    '全部商品': 'All items', '装备': 'Equipment', '消耗品': 'Consumables', '装饰': 'Setup',
    '其他': 'Etc.', '商城物品': 'Cash items', '搜索商品': 'Search items',
    '上衣': 'Top', '其他道具': 'Etc. items', '套服': 'Overall', '宠物': 'Pet',
    '宠物装备': 'Pet equipment', '帽子': 'Hat', '戒指': 'Ring', '手套': 'Gloves',
    '披风': 'Cape', '椅子': 'Chair', '武器': 'Weapon', '现金道具': 'Cash items',
    '盾牌': 'Shield', '眼饰': 'Eye accessory', '耳环': 'Earrings', '脸饰': 'Face accessory',
    '裤裙': 'Bottom', '鞋子': 'Shoes',
    '搜索商品名称 / 英文名 / ID': 'Search Chinese / English name or item ID',
    '物品部位': 'Item slot', '全部部位 / 子分类': 'All slots / subcategories', '适用职业': 'Job',
    '全部职业': 'All jobs', '战士': 'Warrior', '魔法师': 'Magician', '弓箭手': 'Bowman',
    '飞侠': 'Thief', '海盗': 'Pirate', '新手': 'Beginner', '初心者': 'Beginner',
    '通用': 'Universal', '未知': 'Unknown', '全职业': 'All jobs',
    '最低等级': 'Min. level', '最高等级': 'Max. level', '排序': 'Sort by',
    '最近观察': 'Latest observation', '最低价优先': 'Lowest price', '摊位数优先': 'Most shops',
    '等级从低到高': 'Level: low to high', '名称排序': 'Name', '仅看有报价': 'With quotes only',
    '商品': 'Item', '等级 / 部位': 'Level / Slot', '最低报价': 'Lowest ask',
    '中位价 / 最高价': 'Median / Highest', '建议售价 / 件': 'Suggested price / item',
    '在售摊位': 'Listing shops', '售罄价 ⓘ': 'Sold-out price ⓘ',
    '上一页': 'Previous', '下一页': 'Next', '统计口径与基础数据': 'Methodology & source data',
    '保留每次观察，报价只取各摊位最新快照。默认统计近 72 小时，可切换为全部；全部模式也不会重复计算同一摊位的旧快照。明确库存为零才记“售罄记录”，撤摊或商品消失不计成交；实际成交数量与时间未知。价格、数量和售光字段仍需画面核对。旧主动实验保留原始记录，但不参加统计。': 'Every observation is retained; quotes use each shop’s latest snapshot. The default window is 72 hours. All-time view also excludes superseded snapshots. A zero-stock listing is marked as an inferred sold-out; disappeared listings are not counted as sales. Actual sale quantity and time are unknown. Price, quantity and sold-out fields still need in-game verification. Earlier active experiments are excluded from statistics.',
    '图鉴来自本地 DVG 快照与 Mapledex CoT2 参考，各版本分别展示；属性不代表摊位中某件装备的强化结果。图标来自公开图鉴，需要联网，加载失败会显示占位。': 'Reference data comes from local DVG snapshots and Mapledex CoT2, shown separately by version. Reference stats do not describe upgrades on a listed equipment instance. Public item icons require internet access; unavailable icons use a placeholder.',
    '设计参考：': 'Design references:', '本地存储 · 被动统计 · 不自动买卖': 'Local storage · Passive observations · No automatic trades',
    '商品详情': 'Item details', '关闭 ×': 'Close ×', '关闭详情': 'Close item details',
    '选好要卖的，再定价。': 'Choose what to sell, then set the price.',
    '普通个人商店 · 快卖价、正常价与中位价 · 保留自用数量': 'Personal shop · Quick-sale, regular and median prices · Keep a reserve',
    '导出摆摊计划': 'Export selling plan', '正在读取市场数据…': 'Loading market data…',
    '我的背包': 'My inventory',
    '目前由你登记数量并保存在当前浏览器。尚未连接游戏背包；市场中出现的物品不会自动算作你拥有的物品。': 'Quantities are currently entered by you and saved in this browser. Game inventory sync is not connected yet; market listings are not treated as items you own.',
    '物品': 'Item', '搜索名称或物品 ID': 'Search a name or item ID', '数量': 'Quantity',
    '登记 / 更新数量': 'Add / Update quantity', '出售预设': 'Selling preset',
    '仅选择背包中匹配的物品': 'Select matching inventory items', '出售': 'Sell',
    '物品 / 数量': 'Item / Quantity', '保留': 'Reserve', '每组 / 组数': 'Bundle size / Bundles',
    '策略': 'Strategy', '底价 / 件': 'Minimum / Item', '计划组价': 'Planned bundle price',
    '预设依据在售摊位覆盖度，不代表销量。装备属性比较尚未完成，暂不生成自动定价。底价由你填写，不会替你猜最低可接受售价。': 'Presets use listing-shop coverage, not sales volume. Equipment stat comparison is incomplete, so automatic equipment pricing is unavailable. Enter your own minimum acceptable price.',
    '优先考察的位置': 'Locations to check first',
    '坐标将按入口附近、可达平台排序，并需现场确认空位。当前候选不表示已找到可摆摊位置。': 'Coordinates will prioritize reachable platforms near entrances. Vacancy needs an in-game check; these candidates are not confirmed free spots.',
    '执行状态': 'Execution status',
    '背包同步、空位确认和个人商店上架尚未完成实机验证。此页可维护清单、选择预设和导出计划，暂不执行自动上架。': 'Inventory sync, vacancy checks and personal-shop listing are not yet verified in-game. You can manage the list, select presets and export a plan; automatic listing is unavailable.',
    '先登记背包中实际拥有的物品，再应用出售预设。': 'Add items you actually own before applying a preset.',
    '市场常见出售品': 'Common market items', '常见消耗品': 'Common consumables', '常见材料': 'Common materials',
    '近期观察到的不同摊位数，按24小时半衰期加权；不代表买家流量或成交率。': 'Distinct recently observed shops, weighted with a 24-hour half-life. This does not measure buyer traffic or sale probability.',
    '近期位置样本不足，暂不推荐频道或洞号。': 'Not enough recent location data to recommend a channel or room.',
    '保存的背包无法读取，请重新登记。': 'Saved inventory could not be read. Please enter it again.',
    '浏览器未能保存背包，请导出计划留存。': 'Inventory could not be saved. Export a plan to keep a copy.',
    '暂无市场数据': 'No market data', '装备需逐件核对属性': 'Equipment needs instance-level stat checks',
    '报价样本不足': 'Not enough quote samples', '请填底价': 'Enter a minimum price',
    '数量设置无效': 'Invalid quantity settings', '超过可出售数量': 'Exceeds available quantity',
    '组价超出计划上限': 'Bundle price exceeds the plan limit', '背包数量': 'Inventory quantity',
    '保留数量': 'Reserve quantity', '每组数量': 'Items per bundle', '出售组数': 'Bundles to sell',
    '定价策略': 'Pricing strategy', '最低单价': 'Minimum unit price', '移除物品': 'Remove item',
    '移除': 'Remove', '快卖': 'Quick sale', '正常': 'Regular', '中位数': 'Median',
    '请选择唯一的市场物品并填写有效数量。': 'Select one market item and enter a valid quantity.',
    '请先选择要出售的背包物品。': 'Select inventory items to sell first.',
    '位置待识别': 'Location unknown', '此格式暂未解析': 'This format is not decoded yet',
    '未解析': 'Not decoded', '未提供': 'Not provided', '暂无有效报价': 'No valid quotes',
    '待统计': 'Pending analysis', '查看依据': 'View basis', '美中时间': 'US Central time',
    '数据处理异常，请查看日志': 'Data processing error; check the logs', '退出登录': 'Sign out',
    '暂无符合条件的商品。保持网页打开，继续手动逛摊即可。': 'No matching deals yet. Keep this page open as you browse shops.',
    '查看商品依据': 'View item evidence', '历史发现，请重新开摊确认库存和价格': 'Past discovery; revisit the shop to verify stock and price',
    '商品价格库未连接': 'Price database disconnected',
    '实时逛摊提醒在采集电脑的': 'Live browsing alerts are available on the collector computer’s',
    '本地提醒页': 'local alerts page', '使用，公开站不把别人的观察当作你的当前摊位。': '. Other players’ observations are not treated as your current shop.',
    '个人低价提醒请运行新版采集器，启动后会自动打开本机提醒页。只对你新采集到的商品提醒，使用共享报价作比较。': 'Run the updated collector for personal deal alerts. It opens your local alerts page automatically. Only your newly collected listings trigger deal alerts, compared with shared quotes.',
    '个人低价提醒 · 等待打开摊位': 'Personal deal alerts · Waiting for you to open a shop',
    '个人低价提醒 · 正在采集': 'Personal deal alerts · Collecting',
    '个人低价提醒 · 采集器未连接': 'Personal deal alerts · Collector disconnected',
    '共享服务暂不可用，保留上次数据': 'Shared service unavailable; previous data retained',
    '报价共享；低价提醒只来自当前采集身份的新观察': 'Quotes are shared; deal alerts use only this collector’s new observations',
    '查看详情': 'View details', '全部提醒': 'All alerts', '知道了': 'Dismiss',
    '低价商品提醒': 'Deal notifications', '商店名 / 位置': 'Shop / Location', '买价 / 件': 'Buy price / Item',
    '参考卖价 / 件': 'Reference sell price / Item', '扣3%后收益率': 'Margin after 3% fee', '比较依据': 'Comparison basis',
    '本地服务暂未连接；正在等待恢复': 'Local service unavailable; waiting to reconnect',
    '至少两次有效报价观察后显示趋势。每个时间点取当次观察的最低价。': 'A trend needs at least two valid quote observations. Each point uses that visit’s lowest ask.',
    '观察报价趋势': 'Observed price trend', '正在读取本地图鉴…': 'Loading local item reference…',
    '详情加载失败，请重新打开。': 'Details could not be loaded. Please reopen the item.',
    '最低摆摊报价 / 件': 'Lowest shop ask / Item', '摆摊中位价 / 件': 'Median shop ask / Item',
    '售罄价 / 件': 'Sold-out price / Item', '报价观察趋势': 'Observed quote trend',
    '各次访问的观察值，并非全市场同一时刻最低价。': 'Values from individual visits, not the whole market’s simultaneous lowest ask.',
    '包含不同属性装备，仅供粗略参考。': 'Includes equipment with different stats; use as a rough reference.',
    '图鉴基础信息 · DVG 快照': 'Base item reference · DVG snapshot', '需求等级': 'Required level',
    '部位': 'Slot', '图标': 'Icon', '力量要求': 'Required STR', '敏捷要求': 'Required DEX',
    '智力要求': 'Required INT', '运气要求': 'Required LUK', '可交易': 'Tradeable',
    '是': 'Yes', '否': 'No', 'NPC 参考价': 'NPC reference price', '基础属性': 'Base stats',
    '本地图鉴暂无此物品。': 'This item is not in the local reference database.',
    '此来源未提供额外基础属性。': 'No additional base stats are available from this source.',
    '来源缺失': 'Source unavailable', '查看来源 ↗': 'View source ↗',
    '另一版本参考 · Mapledex CoT2': 'Other-version reference · Mapledex CoT2',
    '职业限制': 'Job requirement', '装备类型': 'Equipment type', '暂无对应参考。': 'No matching reference.',
    '。此栏单独保留旧测试版本数据，不与左侧拼成同一套属性。': '. This older test-version data is kept separate from the reference on the left.',
    '摊位装备实际属性': 'Listed equipment instance stats',
    '下方每条报价展示包内属性与剩余强化次数。已解析字段直接展示，未识别的扩展字段单独标注。图鉴基础值不用于填充缺失属性。': 'Each quote shows captured stats and remaining upgrade slots. Unknown fields are labeled separately. Missing stats are not filled from item reference data.',
    '普通物品报价按每组数量折算为单位价格。': 'Ordinary-item quotes are converted to unit prices using bundle size.',
    '当前摊位报价': 'Current shop quotes', '显示位置待识别': 'Include unknown locations',
    '摊位 / 位置': 'Shop / Location', '单位价': 'Unit price', '整组价 / 数量': 'Bundle price / Size',
    '库存': 'Stock', '装备实际属性': 'Equipment instance stats', '观察时间': 'Observed at',
    '售罄价为售罄记录的单位价中位数；采用此前摆摊价，实际成交数量未知。': 'Sold-out price is the median unit price of sold-out observations, using the previous shop ask. Actual sold quantity is unknown.',
    '售罄单价': 'Sold-out unit price', '发现售光时间': 'Sold-out observed at',
    '暂无售罄记录。': 'No sold-out observations.', '摊位 / 时间': 'Shop / Time',
    '下方为共享的结构化观察；网络原文仅保存在采集者本机。': 'Shared structured observations are shown below; raw packets remain on the collector’s computer.',
    '完整原始文件保存在本机；下方列出观察记录和文件引用。': 'Original files are stored locally. Observations and file references are listed below.',
    '已显示全部符合条件的报价。': 'All matching quotes are shown.',
    '当前筛选下没有报价；可勾选“显示位置待识别”查看其他记录。': 'No quotes match these filters. Enable “Include unknown locations” to see other records.',
    '力量': 'STR', '敏捷': 'DEX', '智力': 'INT', '运气': 'LUK', '物理攻击': 'Weapon attack',
    '魔法攻击': 'Magic attack', '物理防御': 'Weapon defense', '魔法防御': 'Magic defense',
    '命中': 'Accuracy', '回避': 'Avoidability', '移动速度': 'Speed', '跳跃': 'Jump', '跳跃力': 'Jump',
    '最大 HP': 'Max HP', '最大 MP': 'Max MP', '基础升级次数': 'Base upgrade slots',
    '攻击速度代码': 'Attack-speed code', '成功率（%）': 'Success rate (%)',
    '暂无普通装备样本': 'No ordinary-equipment samples', '暂无可用报价': 'No usable quotes',
    '样本不足': 'Insufficient samples', '普通属性建议价': 'Ordinary-stat price suggestion',
    '建议试挂价': 'Suggested trial listing price', '样本少': 'Small sample',
    '售光与在售综合': 'Asks and inferred sold-outs', '在售参考': 'Based on current asks',
    '采集服务未运行或状态已过期；仅显示历史数据': 'Collector offline or stale; historical data only',
    '检测到尚未被采集器接管的频道连接；需重连一次（换频道或重新登录）': 'Channel connection is not covered by the collector; reconnect by changing channels or signing in again',
    '游戏已接入并完成协议识别；可以手动逛摊': 'Game connected and protocol recognized; ready for manual browsing',
    '游戏已接入，但商品解析发生错误；请检查采集日志': 'Game connected, but item decoding failed; check collector logs',
    '连接已进入采集器，正在等待协议识别': 'Connection captured; waiting for protocol recognition',
    '暂时无法检测游戏连接；不要将历史数据当作新采集': 'Game connection could not be checked; these records may be historical',
    '尚未检测到已接入的频道连接；等待进入游戏': 'No captured channel connection; waiting for the game',
    '旁路采集正常，正在统计商品': 'Passive capture running; processing items',
    '旁路已启动，等待游戏重新建立频道连接': 'Passive collector started; waiting for a new channel connection',
    '共享市场 · 成员观察数据': 'Shared market · Member observations',
    '同位置/摊位ID/名称/UTC日期的最新快照合并；缺少摊主稳定ID，跨日不合并。': 'Latest snapshots are merged by location, shop ID, name and UTC date. No stable owner ID is available, so observations across dates are kept separate.',
    '当前仅有少量摊位样本。': 'Only a few shop samples are available.',
    '按普通随机属性的市场中低位估价，不另计极品属性溢价；剩余次数不能证明从未使用过卷轴。': 'Uses lower-to-middle prices for ordinary random stats without rare-stat premiums. Remaining slots do not prove that scrolls were never used.',
    '快卖价贴近售光参考；正常卖价取售光参考与在售第40百分位的中点。若当前挂价更低，两档均跟随当前挂价。': 'Quick-sale follows the inferred sold-out reference. Regular price is the midpoint of that reference and the 40th percentile ask. Both follow current asks when those are lower.',
    '暂无售光参考：快卖取在售第25百分位，正常卖取第40百分位。': 'No inferred sold-out reference: quick-sale uses the 25th percentile ask; regular uses the 40th percentile.',
    '暂无在售报价，两档暂用售光参考价。': 'No current asks; both strategies use the inferred sold-out reference.',
    '和朋友一起记录市场价格。输入管理员发给你的独立访问码，查看共同采集的报价。': 'Record market prices with friends. Enter your individual access code to view shared quotes.',
    '成员访问码': 'Member access code', '进入市集': 'Enter market',
    '访问码不要发到群聊或公开仓库。': 'Keep your access code out of group chats and public repositories.',
    '访问码无效或请求过多，请检查后重试。': 'Invalid access code or too many requests. Check and try again.',
    '暂无匹配商品。调整筛选，或手动打开更多摊位。': 'No matching items. Adjust filters or visit more shops.',
    '全部记录': 'All recorded data',
    '排除当前摊位，按其他摊位的更早报价比较，快卖价用于触发提醒，正常卖价用于较高报价参考；列出在售摊位、挂单和库存数量，价差已扣除3%手续费。': 'Excludes the current shop and compares earlier quotes from other shops. Quick-sale triggers alerts; regular price is a higher reference. Shop, listing and stock counts are shown; the spread includes a 3% fee.',
  };
  const rules = [
    [/^建议售价 \/ 件：快卖 (.+) · 正常卖 (.+)$/, (_,f,n) => `Suggested price / item: quick sale ${f} · regular ${n}`],
    [/^(\d+)频道 · (自由市场入口|\d+洞)(（待实测核对）)?$/, (_,c,r,p) => `Channel ${c} · ${r==='自由市场入口'?'Free Market entrance':`Room ${r.slice(0,-1)}`}${p?' (pending in-game verification)':''}`],
    [/^近\s*(\d+)(小时|h)$/, (_,n,u) => `Last ${n}${u==='h'?'h':' hours'}`],
    [/^第 (\d+) \/ (\d+) 页 · 每页 (\d+) 件商品$/, (_,p,n,s) => `Page ${p} / ${n} · ${s} items per page`],
    [/^(\d+) 个在售装备记录 · 区间仅供参考$/, (_,n) => `${n} equipment records · Indicative range`],
    [/^(.*)单位报价$/, (_,w) => `${translate(w)} unit quotes`],
    [/^最高 (.+)$/, (_,n) => `Highest ${n}`], [/^最低 (.+)$/, (_,n) => `Lowest ${n}`],
    [/^快卖 (.+)$/, (_,n) => `Quick sale ${n}`], [/^正常卖 (.+)$/, (_,n) => `Regular ${n}`],
    [/^(\d+) 条挂单$/, (_,n) => `${n} listings`], [/^(\d+) 条售罄记录$/, (_,n) => `${n} sold-out observations`],
    [/^更新 (.+) · (实时推送|每2秒检查更新)$/, (_,d,m) => `Updated ${d} · ${m==='实时推送'?'Live updates':'Checked every 2 seconds'}`],
    [/^(.+) · 位置待识别$/, (_,s) => `${translate(s)} · Location unknown`],
    [/^已保留 (\d+) 次手动访问、(\d+) 条商品观察。另有 (\d+) 次旧主动实验，已排除统计。$/, (_,v,o,e) => `${v} manual visits and ${o} item observations retained. ${e} earlier active experiments excluded.`],
    [/^共享观察 (\d+) 次 · (.+)$/, (_,n,b) => `${n} shared observations · ${translate(b)}`],
    [/^公开市场 · 采集端使用独立随机 ID · (.+)$/, (_,b) => `Public market · Collectors use individual random IDs · ${translate(b)}`],
    [/^当前 (\d+) 条 · 最近记录 (\d+) 条（此浏览器保留24小时，最多200条）$/, (_,a,n) => `${a} current alerts · ${n} recent records (24 hours in this browser; up to 200)`],
    [/^发现 (\d+) 件低价商品$/, (_,n) => `${n} deals discovered`],
    [/^强化$/, () => 'Upgrades'], [/^剩余强化$/, () => 'Remaining upgrade slots'],
    [/^(\d+) 个扩展字段未解析$/, (_,n) => `${n} extra fields not decoded`],
    [/^职业代码 (.+)$/, (_,n) => `Job code ${n}`],
    [/^(\d+) 条 · (\d+) 个摊位$/, (_,n,s) => `${n} quotes · ${s} shops`],
    [/^已隐藏 (\d+) 条位置待识别报价；此筛选仅影响下方列表。$/, (_,n) => `${n} quotes with unknown locations hidden. This filter only affects the list below.`],
    [/^历史装备属性 · (\d+) 条观察$/, (_,n) => `Historical equipment stats · ${n} observations`],
    [/^原始依据 · (\d+) 条商品观察（点击展开）$/, (_,n) => `Source evidence · ${n} item observations (expand)`],
    [/^(.+) 金币$/, (_,n) => `${n} mesos`], [/^(\d+) 个报价摊位$/, (_,n) => `${n} quoted shops`],
    [/^(\d+) 个近期摊位 · 空位待确认$/, (_,n) => `${n} recent shops · Vacancy unconfirmed`],
    [/^(.+) · (\d+)频道 \/ (\d+)洞$/, (_,w,c,r) => `${w} · Channel ${c} / Room ${r}`],
    [/^出售 (.+)$/, (_,n) => `Sell ${n}`],
    [/^市场数据更新于 (.+) · 背包数量由玩家维护$/, (_,d) => `Market updated ${d} · Inventory quantities entered by the player`],
    [/^市场数据暂不可用（(.+)）；已保存的背包仍可保留。$/, (_,e) => `Market data unavailable (${e}); your saved inventory is retained.`],
    [/^(近\d+小时|全部记录)没有符合条件的在售或售光推定样本。$/, (_,w) => `No eligible ask or inferred sold-out samples in ${translate(w).toLowerCase()}.`],
    [/^普通属性参考价：采用 (\d+) 条未成功强化且仍有升级次数的同名装备报价；排除已强化、次数耗尽和属性未解析的记录。$/, (_,n) => `Ordinary-stat reference: ${n} same-name equipment quotes with no successful upgrades and remaining slots. Upgraded, exhausted or undecoded instances are excluded.`],
    [/^(近\d+小时|全部记录)在售报价来自 (\d+) 个摊位，售光推定来自 (\d+) 个摊位；每摊先取中位数，同一售光挂单重复观察不增加权重。$/, (_,w,a,s) => `${translate(w)}: asks from ${a} shops and inferred sold-outs from ${s} shops. Each shop contributes its median; repeat sold-out observations do not add weight.`],
    [/^在售报价排除 (\d+) 个异常摊位样本，售光推定排除 (\d+) 个异常摊位样本。$/, (_,a,s) => `${a} ask outliers and ${s} inferred sold-out outliers excluded.`],
    [/^售光推定参考价 (.+)；采用发现售光时记录的单位价。$/, (_,p) => `Inferred sold-out reference ${p}, using the unit price recorded when the listing was found sold out.`],
    [/^在售报价第40百分位 (.+)。$/, (_,p) => `40th percentile of asks: ${p}.`],
    [/^快卖参考 (.+)、正常卖参考 (.+)，两档均整理为尾数9。$/, (_,f,n) => `Quick-sale reference ${f}; regular reference ${n}. Both are rounded to a price ending in 9.`],
    [/^单价低于1金币：可按100件一组，参考整组价 (.+) 金币；上架时核对每组数量。$/, (_,p) => `Below 1 meso per item: a 100-item bundle would be about ${p} mesos. Verify the bundle size before listing.`],
  ];
  // Short phrases only for compound UI labels, never for raw evidence or inputs.
  const fragments = {
    '扣费后收益率：': 'Margin after fees: ', '每件价差：': 'Spread per item: ',
    '旧版参考卖价': 'Legacy reference sell price', '收益率': 'Margin',
    '每组 ': 'Bundle ', '买价 ': 'Buy ', '正常卖 ': 'Regular ', '快卖 ': 'Quick sale ',
    '价差 ': 'Spread ', '/件': '/item', ' 每件': ' per item', '件）': ' items)', '件': ' items',
    '个报价摊位': ' quoted shops', '个在售摊位': ' listing shops', '条在售挂单': ' active listings',
    '库存合计 ': 'Total listed stock ', '建议售价 / 件：': 'Suggested price / item: ',
    '强化 ': 'Upgrades ', '剩余强化 ': 'Remaining upgrade slots ',
    ' · 数据处理异常，请查看日志': ' · Data processing error; check the logs',
    '。此栏单独保留旧测试版本数据，不与左侧拼成同一套属性。': '. This older test-version data is kept separate from the reference on the left.',
  };
  const textSource = new WeakMap(), attrSource = new WeakMap(), translatedSources = new Map();
  let language = 'zh';
  try { language = localStorage.getItem('market.language') === 'en' ? 'en' : 'zh'; } catch {}
  function translate(value) {
    const raw = String(value ?? '');
    if (language === 'zh') return raw;
    const source = raw.trim();
    let result = messages[source];
    if (result === undefined) {
      for (const [pattern, render] of rules) {
        const match = source.match(pattern);
        if (match) { result = render(...match); break; }
      }
    }
    if (result === undefined) {
      result = source;
      for (const [original, english] of Object.entries(fragments).sort((a,b)=>b[0].length-a[0].length))
        result = result.split(original).join(english);
    }
    const output = raw.slice(0, raw.length-raw.trimStart().length) + result + raw.slice(raw.trimEnd().length);
    if (output !== raw) {
      translatedSources.set(output, raw);
      if (translatedSources.size > 4096) translatedSources.delete(translatedSources.keys().next().value);
    }
    return output;
  }
  function apply(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script,style,pre,code,[data-no-i18n],.leaf')) continue;
      const previous = textSource.get(node);
      const source = previous && node.nodeValue === previous.output ? previous.source : translatedSources.get(node.nodeValue) ?? node.nodeValue;
      const output = translate(source);
      if (node.nodeValue !== output) node.nodeValue = output;
      textSource.set(node, { source, output });
    }
    for (const element of root.querySelectorAll?.('[placeholder],[aria-label],[title],option') ?? []) {
      // Implicit option values must remain canonical when their visible labels change.
      if (element.tagName === 'OPTION' && !element.hasAttribute('value')) {
        const original = textSource.get(element.firstChild)?.source ?? element.textContent;
        element.setAttribute('value', original);
      }
      const saved = attrSource.get(element) ?? {};
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        if (!element.hasAttribute(attr)) continue;
        const current = element.getAttribute(attr), previous = saved[attr];
        const source = previous && current === previous.output ? previous.source : current;
        saved[attr] = { source, output: translate(source) };
        element.setAttribute(attr, saved[attr].output);
      }
      attrSource.set(element, saved);
    }
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-language]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.language === language));
    });
  }
  function setLanguage(next) {
    language = next === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('market.language', language); } catch {}
    apply();
    window.dispatchEvent(new CustomEvent('market-languagechange', { detail: language }));
  }
  function install() {
    const control = document.createElement('div');
    control.className = 'language-switch';
    control.setAttribute('role', 'group'); control.setAttribute('aria-label', '中文 / English');
    control.innerHTML = '<button type="button" data-language="zh" lang="zh-CN">中文</button><button type="button" data-language="en" lang="en">English</button>';
    control.querySelectorAll('button').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language)));
    (document.querySelector('header') ?? document.querySelector('main') ?? document.body).append(control);
    apply();
  }
  window.MarketI18n = {
    t: translate, apply, setLanguage,
    get language() { return language; },
    get locale() { return language === 'en' ? 'en-US' : 'zh-CN'; },
    name: item => language === 'en' && item.name_en ? item.name_en : item.name_zh ?? item.name ?? String(item.item_id),
  };
  install();
})();
