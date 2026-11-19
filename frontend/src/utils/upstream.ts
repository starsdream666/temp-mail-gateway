import type { UpstreamDetail, UpdateUpstreamPayload } from '../types';

type UpstreamDraft = Pick<UpstreamDetail, 'name' | 'baseUrl' | 'enabled' | 'settings'>;

/** 只发送用户改过的字段，避免名称编辑覆盖其他页面刚保存的设置。 */
export function changedUpstreamFields(initial: UpstreamDraft, draft: UpstreamDraft): UpdateUpstreamPayload {
  const patch: UpdateUpstreamPayload = {};
  if (draft.name !== initial.name) patch.name = draft.name;
  if (draft.baseUrl !== initial.baseUrl) patch.baseUrl = draft.baseUrl;
  if (draft.enabled !== initial.enabled) patch.enabled = draft.enabled;
  if (JSON.stringify(draft.settings) !== JSON.stringify(initial.settings)) {
    patch.settings = draft.settings;
    patch.expectedSettings = initial.settings;
  }
  return patch;
}
