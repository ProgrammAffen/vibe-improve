# license-api

CloudBase 事件云函数，入口 `index.main`。共享客户端通过已登录 CloudBase Web SDK 的 `callFunction` 调用；不配置公开 HTTP 触发器。锁定 `@cloudbase/node-sdk@3.18.3`，Node 18 或更高平台运行时。

## 配置

| 环境变量 | 要求 |
| --- | --- |
| CLOUDBASE_ENV_ID | `one-person-company-7dao3979fd72e` |
| LICENSE_PRODUCT_ID | `vibe-improve`，与客户端信任配置一致 |
| LICENSE_ISSUER / LICENSE_AUDIENCE | 固定签发者与接收方，客户端独立核对 |
| LICENSE_SIGNING_KEY_ID | 已发布证书公钥的版本 ID |
| LICENSE_SIGNING_PRIVATE_KEY_PEM | Ed25519 PKCS8 PEM，仅云函数环境 Secret |
| LICENSE_ACTIVATION_PUBLIC_KEY_PEM | 激活码专用 Ed25519 SPKI PEM 公钥，与证书签名密钥分离 |
| LICENSE_MAX_DEVICES | 必填 1–100 整数，当前 2；所有账户的实时设备上限 |
| LICENSE_LEASE_SECONDS | 必填正整数，当前 604800（168 小时） |
| LICENSE_OFFLINE_GRACE_SECONDS | 非负整数，当前 0，不额外延长签名租约 |
| LICENSE_RATE_LIMIT_PER_MINUTE | 每账号每分钟调用上限，默认 60 |
| LICENSE_ALLOWED_LOGIN_TYPES | 经平台实测的非匿名 LOGINTYPE 精确值，逗号分隔 |

配置缺失、错误或身份无法证明时拒绝服务。证书签名私钥和激活码签发私钥均不得进入前端、App、源码或日志；函数仅需要激活码公钥。已有证书签名密钥不因激活码机制升级而轮换。

函数鉴权使用本次平台第二参数 context，经 `app.auth().getAuthContext(context)` 和 `cloudbase.getCloudbaseContext(context)` 确认 uid 及非匿名身份。缺少明确非匿名标记时，仅接受已实测配置的 loginType；不接受 event.context、客户端 userId 或 Authorization 文本冒充。

## 请求与响应

```js
const response = await app.callFunction({
  name: 'license-api',
  data: { action: 'status', deviceId, clientTraceId: crypto.randomUUID() },
});
```

成功 `{ok:true,data,traceId,clientTraceId?}`；失败 `{ok:false,error:{code,retryable},traceId,clientTraceId?}`。业务请求最大 4 KiB，未知字段拒绝。适配层移除平台 tcbContext 与合法 clientTraceId，二者均不参与业务身份。

| action | 字段（除 action） | 结果 |
| --- | --- | --- |
| status | deviceId 可选 | serverNow、status、entitlement/null、当前 device/null |
| activate | requestId、activationCode、deviceId、deviceName、appVersion | 同事务兑换权益并绑定，返回授权租约结果 |
| bind | requestId、deviceId、deviceName、appVersion | 在线绑定或重新绑定当前安装，返回授权租约结果 |
| renew | requestId、deviceId、bindingId、leaseToken、renewalId、nextLeaseToken | 轮换 token，返回授权租约结果 |
| devices | currentDeviceId 可选 | serverNow、entitlement/null、实时 maxDevices、活跃 devices |
| revoke | requestId、deviceId | serverNow、deviceId、revoked:true；过期账号仍可管理 |

带合法`clientTraceId`的成功响应顶层增加`timeProof`，以固定Ed25519证书密钥签名`purpose=server-time-v1 / userId / nonce / serverTime`及产品信任字段。每次调用在幂等业务回执之外生成，客户端用当前请求随机码验证，不能用旧回执时间重设离线计时。

授权租约结果包含 `serverNow / status / entitlement / device / certificate / leaseToken / leaseExpiresAt / maxDevices / leaseDurationHours`。

- `entitlement={licenseId,productId,features,maxDevices,expiresAt,issuedAt}`。
- `device={deviceId,bindingId,deviceName,appVersion,slotIndex,boundAt,lastSeenAt,leaseExpiresAt,offlineUntil,isCurrent}`。
- 安装 ID 为持久化安全随机值，不是硬件指纹，不证明唯一物理机器。格式为 16–128 位字母、数字、下划线或短横线。
- deviceName 最多 80 字符，appVersion 最多 40 字符。绑定世代 bindingId 由服务端产生，撤销后重绑会更换。
- 每个写操作使用独立 requestId；请求结果丢失时以同 ID 和相同参数重试，禁止盲目换 ID。跨 action 复用 ID 返回 IDEMPOTENCY_KEY_REUSED。

## 激活码 v2

共享算法见 `activation-code-v2.mjs`。新码为 `VI-` 前缀、四字符分组、共 157 个显示字符；字母表 `23456789ABCDEFGHJKMNPQRSTUVWXYZ` 实际为 **31 进制**。

77 字节帧由 13 字节 payload 与 64 字节 Ed25519 签名组成：header `0x21` 表示 version 2 / profile 1；随后两个 uint16BE 分别为有效天数和自 2026-01-01 UTC 起的签发天；最后 8 字节为安全随机 nonce。签名输入为 UTF8 `vibe-improve:activation:v2`、一个 NUL 字节及原始 payload。profile 1 为 Pro，功能 `app.access`。不携带设备数。

发码在管理员本地离线签名，不预录数据库。正规化去空白/横线、大写，规范码串以 VI 开头；仅将 SHA-256 codeHash/payloadHash、兑换归属、时长/profile、首设备及时间写云端。验签固定使用独立预配公钥，拒绝未知 profile、错误结构/签名以及超过服务器一天的未来签发日。

首次兑换从服务器当前时间起计算有效期。新码续期为 `max(原到期,现在+有效天数)`，保持 licenseId，不把天数叠加在旧到期上。同账号重用已兑换码只领取设备租约，不重复加时；其他账号不能重用。管理员撤销状态不能靠新码恢复。

原 VI1 随机哈希库中未兑换码继续可用，沿用其既有功能与绝对到期，设备上限按当前服务器配置。已有合法授权与安装 ID 不清空。云端不复用源项目的 VL 命名空间、激活密钥、信任域或业务数据。

## 事务、设备槽与迁移

集合仍为 `vi_license_accounts / vi_license_activation_codes / vi_license_devices / vi_license_receipts / vi_license_rate_limits`，普通客户端直接读写全部拒绝；仅函数和管理员访问。

账号文档由 `SHA256(productId + NUL + trustedUid)` 定位，内嵌当前权益和以设备 ID 哈希为键的活跃设备映射。该账号记录在事务中串行化同一权益的兑码、占位、续租与撤销。兑换归属、权益写入、设备绑定、签名租约及回执在同一事务提交，设备满或存储失败不消耗新码。

每个设备分配 `0..maxDevices-1` 固定槽。槽 marker 与原设备租约文档共存于 devices 集合：marker ID 为 `slot_<SHA256(productId + NUL + uid + NUL + licenseId).slice(0,32)>_<slotIndex>`，带 `kind:'slot'`。设备租约文档保持原 `SHA256(productId + NUL + uid + NUL + deviceId)` ID，保留既有记录的可恢复路径。列表从账号活跃映射读取，不把 marker 当额外设备。

老设备缺少 slotIndex 时按已有映射分配空位，下次成功写操作原子补齐；保留 deviceId/bindingId/授权到期。已有 tokenless 旧设备只允许一次旧格式 renew，返回新 leaseToken；一旦账号映射或设备行存在 leaseTokenHash，后续必须使用新协议，不能降级无 token。旧行损坏或身份冲突时拒绝，不重置设备列表绕过配额。

重复 bind 不增加席位，保留 boundAt；每次成功发新安全随机 32 字节 hex token，云端设备仅保存 SHA-256。达到上限返回 DEVICE_LIMIT_REACHED，仍允许账号和设备管理。上限下调后范围外槽不可重绑/续租，也不能趁低位空缺绕过总数限制。

revoke 原子删除活跃映射、标记设备和槽撤销，名额立即可重用；不退出操作端账号。退出登录不释放云端名额。明确撤销不能由自动续租重新创建绑定；再次绑定是单独在线动作。

## 租约轮换、幂等与签名

renewalId 必须匹配 `renew_[a-f0-9]{32}`；当前和 nextLeaseToken 均为 64 位小写 hex 且必须不同。当前 token hash、bindingId 和活跃状态在同一事务校验。保存最后 renewalId、前 token hash、当前 next token hash及回执 ID；重放同一三元返回同一结果，不再次延长租约。不同续租请求竞争同一旧 token 时只有一个成功。过期租约可在线续期，但权益必须仍有效且设备未撤销。

回执不保存 leaseToken 明文。租约结果中的 token 使用证书签名私钥派生的独立 AES-256-GCM 用途密钥封装，随机 12 字节 nonce，AAD 绑定独立回执域、keyId、issuer、audience 与 productId。回执只保存密文 envelope 与不含 token 的结果；重放先校验当前 license/binding/token hash，再认证解密。错误密钥或密文损坏拒绝，不输出 token。密钥派生用途与 Ed25519 证书签名输入分离。

证书 `{algorithm:'Ed25519',keyId,payload,signature}` 保持现有合同。payload 为确定键序 JSON UTF8 后 base64url；签名输入是 payload 文本的 ASCII 字节。签名 claims 覆盖 `schemaVersion / keyId / issuer / audience / productId / licenseId / userId / deviceId / bindingId / features / issuedAt / notBefore / expiresAt / leaseExpiresAt / offlineUntil`。

客户端使用固定受信公钥，逐项验证签名、身份、绑定及期限。租约和离线期限均不超过权益到期。离线只允许签名期限内的功能，不因续租 pending 或重试延长。已知撤销立即拒绝；未知远程撤销的传播上界为剩余签名离线期限。

## 错误与内部日志

公共错误沿用 AUTH_REQUIRED、AUTH_CONTEXT_UNSUPPORTED、INVALID_REQUEST、INVALID_ACTIVATION_CODE、ACTIVATION_CODE_UNAVAILABLE、GRANT_EXPIRED、LICENSE_REQUIRED、LICENSE_EXPIRED、LICENSE_REVOKED、LICENSE_CHANGED、DEVICE_LIMIT_REACHED、DEVICE_REVOKED、DEVICE_NOT_FOUND、IDEMPOTENCY_KEY_REUSED、RATE_LIMITED、DATA_INTEGRITY_ERROR、SERVICE_UNCONFIGURED、SERVICE_UNAVAILABLE。

每次调用只输出一行白名单 JSON：schemaVersion、timestamp、level、固定 license_request、服务端 traceId、可选 clientTraceId、action、durationMs、resultCode 及受限诊断细节。未知异常只归类 SERVICE_UNAVAILABLE。客户端用 clientTraceId 关联云端 traceId；不记录用户、邮箱、安装 ID、原码、租约 token、请求正文、context 或异常 message/stack。日志失败不改变业务结果，日志只在程序内部记录。

## 验证与部署

运行 `node --test tests/license-service.test.mjs tests/license-replica-service.test.mjs` 验证原子兑换、竞争占位、哈希保密、续期语义、回执丢失恢复、token竞争/撤销、全局上限下调和旧设备升级。内存事务测试不替代真实 CloudBase 并发验证。

发布目录白名单必须包含 activation-code-v2.mjs 及现有服务/适配/诊断文件。环境新增激活公钥和全局设备数，原证书密钥保持。更新仅操作 Vibe Improve 的函数与 vi_* 集合，不执行源项目清空脚本，不改变其他产品的路由、身份、数据库或密钥。
