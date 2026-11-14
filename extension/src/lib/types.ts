import type { components } from '../api/schema';

type S = components['schemas'];

export type Item = S['Item'];
export type ItemWithPath = S['ItemWithPath'];
export type Library = S['Library'];
export type Tree = S['Tree'];
export type LookupResult = S['LookupResult'];
export type QuickSaveRequest = S['QuickSaveRequest'];
export type QuickSaveResult = S['QuickSaveResult'];
export type UpdateItemRequest = S['UpdateItemRequest'];
export type WriteItemResult = S['WriteItemResult'];
export type WriteResult = S['WriteResult'];
export type SearchHit = S['SearchHit'];
export type SearchResult = S['SearchResult'];
export type Settings = S['Settings'];
export type SettingsPatch = S['SettingsPatch'];
export type SaveTarget = S['SaveTarget'];
export type StartPage = S['StartPage'];
export type StartSection = S['StartSection'];
export type AiStatus = S['AiStatus'];
export type AiSuggestion = S['AiSuggestion'];
export type AiSuggestRequest = S['AiSuggestRequest'];
export type SystemInfo = S['SystemInfo'];
export type Me = S['Me'];
export type TokenCreated = S['TokenCreated'];
export type ErrorCode = S['ErrorCode'];
export type ApiErrorBody = S['Error'];
