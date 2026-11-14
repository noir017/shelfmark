// 应用内共享的 API 实例；界面层在启动时通过 api.hooks 挂上回调
import { createApi } from './client'

export const api = createApi()
export const client = api.client
export { unwrap, ApiError, NetworkError, AccessExpiredError } from './client'
