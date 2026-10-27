# License 数据库

部署管理员按 `license-schema.json` 在目标环境创建五个集合，并将普通客户端读写权限全部设为拒绝。函数调用权限限制已登录非匿名用户；函数内再核验可信平台身份。不要公开 HTTP 管理接口或允许客户端直接兑换数据库文档。

| 集合 | 文档内容与约束 |
| --- | --- |
| vi_license_activation_codes | `_id=SHA256(规范化完整激活码)`；只存 hash、productId、maxDevices、features、expiresAt、status、领取身份/时间。原码仅存在管理员指定的0600文件。状态 available→claimed；事务内单次领取 |
| vi_license_accounts | 每产品/用户一个确定ID，包含licenseId、权益参数、active/revoked、revision和有效设备映射。设备上限1—100为技术输入限制；真实上限由各码给出，无默认套餐 |
| vi_license_devices | 用户/产品/安装ID的确定文档，包含bindingId、名称、版本、租约时间、active/revoked、撤销时间。随机安装ID不证明物理设备唯一性 |
| vi_license_receipts | 整个用户/产品范围的requestId唯一。保存请求hash、响应和授权/绑定guard；同ID不同参数拒绝。证书响应不保存任何签名私钥或激活原码 |
| vi_license_rate_limits | 用户/产品/分钟桶，计数和expiresAt。每次调用独立限流事务，失败兑码也计数 |

内置唯一 `_id` 索引满足所有业务事务；事务内不使用 where，不请求外部服务。激活码占用、账号授予和回执同事务；设备绑定/撤销、账号席位及回执同事务。最多读取账号、码或设备、回执三个业务文档。列表直接读取账号内受限大小的设备映射。

可创建 `expiresAt_ascending` 普通索引，并用受控管理员任务清理过期限流桶；它不是已部署的TTL索引。不得清理尚需重试的回执，当前版本不自动清理。被撤销设备墓碑保留，重新显式绑定产生新bindingId，旧续租/绑定回执不能恢复已撤销绑定。

本文件和JSON是部署规格，不会自动创建云资源。需要在实际环境验证集合权限、事务冲突重试和callFunction身份注入后才能宣称云端可用。源代码不自动创建集合或更改规则。
