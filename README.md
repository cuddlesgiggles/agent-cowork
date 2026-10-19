# magpie-agent-cowork

把 **团结 Cowork**（Tuanjie Cowork，本地 agent 是 `codely.exe`）接成 magpie 的一个 agent：
在 magpie 里给 Cowork 选一个模型，Cowork 就用 magpie 网关上那个模型说话——用的是你已经在
magpie 里登进去的那些订阅的额度，Cowork 自己不用另登录。

```
magpie cowork workbuddy/deepseek-v4.1-flash     # 换 Cowork 的聊天模型
magpie cowork                                    # 看它现在用哪个
magpie cowork default                            # 把 Cowork 交还给它自己原来的选择
```

装：

```sh
magpie plugin add ./agent-cowork                       # 本地目录
magpie plugin add github:cuddlesgiggles/agent-cowork   # 发布之后
```

## 先跑一次 seed

Cowork 的模型清单在 `~/.codely/settings.json`，它当前用哪个模型记在 `~/.codely/ide-settings.json`
的 `defaultChatModelTitle`（值就是模型字符串，也是它写进请求体 `model` 的那个字符串）。
这个插件只维护后一个文件——magpie 的 agent 插件按契约只能碰一个配置文件，而前一个文件里是数组，
magpie 的写入器碰到 `customModels: []` 会写成 `{"0": {…}}`，Cowork 读不了。
所以模型清单由包里的 `seed.mjs` 从 magpie 的 `/v1/models` 一次性搬过去：

```sh
cd agent-cowork
node seed.mjs            # 写之前把旧文件留成 settings.json.pre-magpie
node seed.mjs --check    # 只报漂移，不写；有漂移时退出码 1
```

它只做加法：已经在清单里的模型（不管挂在谁名下）不重复加，magpie 已经不再提供的 `magpie:` 条目会被
摘掉，你自己在 Cowork 里加的条目一概不动。搬完之后，`magpie cowork <模型>` 就能直接切，
不用回 Cowork 的模型列表里点。

改动生效的时机：Cowork 启动时读这个文件，所以重启 Cowork 或新开一个会话才用新模型。

## 装完怎么确认

```sh
magpie ls          # 应当有一行 Tuanjie Cowork，右边是它当前的模型和配置路径
magpie cowork <某个模型>
cat ~/.codely/ide-settings.json     # defaultChatModelTitle 应当已经变成那个模型
```

然后在 Cowork 里发一句话，回话应当来自那个模型。若它回的是别的模型，说明那个名字在 Cowork 的清单里
没有对应条目——再跑一次 `node seed.mjs`。

图标取自 Cowork 安装包里的 `app/resource/dist/branding/logo_dark.png`，缩到 112px 后内联成 data URI
（和 `@magpie-community/agent-kimi-desktop` 一样的做法，好处是不依赖仓库先建好），同图另存一份 `icon.png` 随包发。
