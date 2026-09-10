import type { ApiKeyRow } from "../ports/stores";
import type { RuntimeSettings } from "../core/settings";

/** OpenAPIHono 全局上下文类型 */
export type Env = { Variables: { apiKey: ApiKeyRow; settings: RuntimeSettings } };
