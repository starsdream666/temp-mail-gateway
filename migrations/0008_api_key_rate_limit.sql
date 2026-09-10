-- 每个 key 可覆盖邮箱创建限速；现有 key 的 NULL 值继续继承环境变量默认值。
-- 0 表示不限速，正整数表示每小时创建请求上限。
ALTER TABLE `api_keys` ADD `mailboxes_per_hour` integer;
