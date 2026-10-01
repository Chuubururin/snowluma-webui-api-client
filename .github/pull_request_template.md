<!-- 感谢贡献。请填写以下内容，方便评审。 -->

## 关联 Issue

<!-- 例如 Closes #123。若无关联 issue，请说明这个 PR 解决什么问题、为何现在做。 -->

## 变更说明

<!-- 简述本 PR 做了什么、为什么这样做。动了 spec/anchor/生成面时，说明判据来源。 -->

## 提交前检查

- [ ] 本 PR 聚焦单一目标，未夹带无关改动
- [ ] `npm run verify:all` 本地全绿（9 条离线门禁；动了流端点/生成面时不得以 skip 充数）
- [ ] 动了 `spec/openapi.yaml`：已跑全量 `npm run generate` 重建三语产物（否则 probe 血统收据红）
- [ ] 动了 demo 面：`npm run typecheck:demo` 与 `npm run ui-coverage` 绿；新控件有 parity 边或 declination 记录
- [ ] 文件行尾为 LF（未引入 CRLF）
- [ ] PR 描述与实际实现一致

## 合入

CI（`verify`，windows-latest 冷克隆）绿 **且** 人工审核通过后由审核人合入——本仓禁用 auto-merge。
