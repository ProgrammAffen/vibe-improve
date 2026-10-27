export type DirectoryChoice = {token: string; path: string; name: string};
export type ProjectRecord = {
  format: 'vibe-improve.project'; schemaVersion: 1; id: string; name: string; revision: number;
  state: 'draft'; kind: 'draft' | 'project'; createdAt: string; updatedAt: string; lastOpenedAt: string;
  path: string; available: boolean; completedNodes: number; totalNodes: number; directory?: DirectoryChoice;
};
export type ProjectDraft = {name: string; directory?: DirectoryChoice};
export const PROJECT_ERRORS = [
  'PROJECT_NAME_INVALID', 'PROJECT_DIRECTORY_REQUIRED', 'PROJECT_EXISTS', 'PROJECT_UNAVAILABLE',
  'PROJECT_INVALID', 'PROJECT_CONFLICT', 'PROJECT_LIMIT', 'PROJECT_STORAGE_UNAVAILABLE', 'PROJECT_PICKER_UNSUPPORTED',
] as const;
export type ProjectErrorCode = typeof PROJECT_ERRORS[number];
export function validProjectName(value: string): boolean {
  const name = value.normalize('NFC');
  return name.length > 0 && [...name].length <= 80 && new TextEncoder().encode(name).length <= 255 && name === name.trim() && name !== '.' && name !== '..'
    && !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(name) && !name.endsWith('.')
    && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name);
}
export function validateProject(value: unknown): ProjectRecord {
  if (!value || typeof value !== 'object') throw new Error('PROJECT_INVALID');
  const p = value as Partial<ProjectRecord>;
  if (p.format !== 'vibe-improve.project' || p.schemaVersion !== 1 || typeof p.id !== 'string'
    || !/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(p.id) || typeof p.name !== 'string' || !validProjectName(p.name)
    || !Number.isSafeInteger(p.revision) || p.revision! < 1 || p.revision! > 999_999 || p.state !== 'draft'
    || [p.createdAt,p.updatedAt,p.lastOpenedAt].some(v => typeof v !== 'string' || !Number.isFinite(Date.parse(v))))
    throw new Error('PROJECT_INVALID');
  return {
    format: p.format, schemaVersion: 1, id: p.id, name: p.name, revision: p.revision!, state: 'draft', kind: p.kind === 'project' ? 'project' : 'draft',
    createdAt: p.createdAt!, updatedAt: p.updatedAt!, lastOpenedAt: p.lastOpenedAt!,
    path: typeof p.path === 'string' ? p.path : '', available: p.available !== false, completedNodes: 0, totalNodes: 0,
    ...(p.directory && typeof p.directory.token === 'string' && typeof p.directory.path === 'string' ? {directory: p.directory} : {}),
  };
}
export function projectErrorCode(cause: unknown): ProjectErrorCode {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return PROJECT_ERRORS.find(code => message.includes(code)) ?? 'PROJECT_STORAGE_UNAVAILABLE';
}
export function selectProjects(records: ProjectRecord[], search: string, sort: 'recent' | 'name') {
  const query = search.trim().normalize('NFC').toLocaleLowerCase();
  return records.filter(p => p.name.normalize('NFC').toLocaleLowerCase().includes(query)).sort((a,b) =>
    sort === 'name' ? a.name.localeCompare(b.name) : Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt) || a.id.localeCompare(b.id));
}
export function projectMessage(code: ProjectErrorCode, english: boolean): string {
  const messages: Record<ProjectErrorCode, [string,string]> = {
    PROJECT_NAME_INVALID: ['名称须为 1–80 个字符，不含路径符号或保留名称。','Use 1–80 characters without path symbols or reserved names.'],
    PROJECT_DIRECTORY_REQUIRED: ['请选择项目目录。','Choose a project location.'],
    PROJECT_EXISTS: ['此位置已有同名项目或文件夹，请更改名称或目录。','A project or folder with this name exists here. Choose a different name or location.'],
    PROJECT_UNAVAILABLE: ['无法访问目录，请重新选择。','The folder is unavailable. Choose it again.'],
    PROJECT_INVALID: ['所选目录不是兼容的 Vibe Improve 项目。','The selected folder is not a compatible Vibe Improve project.'],
    PROJECT_CONFLICT: ['项目已在其他窗口更新，请重新打开。','This project changed in another window. Open it again.'],
    PROJECT_LIMIT: ['已达到本地项目记录上限。','The local project index is full.'],
    PROJECT_STORAGE_UNAVAILABLE: ['无法保存或读取项目，请检查目录权限后重试。','Cannot save or read projects. Check folder permissions and retry.'],
    PROJECT_PICKER_UNSUPPORTED: ['请在桌面应用中选择项目目录。','Choose the project folder in the desktop app.'],
  };
  return messages[code][english ? 1 : 0];
}
