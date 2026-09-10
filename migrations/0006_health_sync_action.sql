-- 域名差异的处置结果：'applied' / 'detected' / 'blocked:<原因>'；无差异时 NULL。
-- 健康检查从"只检测域名增删"升级为"默认自动同步进注册表"后，需要区分
-- 「已自动应用」与「触发安全闸未应用（需人工确认）」——否则被拦下的批量移除
-- 只会表现为时间线里反复出现同一条差异，管理员看不出需要介入。
ALTER TABLE `health_checks` ADD `sync_action` text;
