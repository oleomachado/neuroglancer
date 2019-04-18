import { SharedWatchableValue } from "neuroglancer/shared_watchable_value";
import { CancellationToken, uncancelableToken } from "neuroglancer/util/cancellation";

export const AUTHENTICATION_GET_SHARED_TOKEN_RPC_ID = 'Authentication.get_shared_token';
export const AUTHENTICATION_REAUTHENTICATE_RPC_ID = 'Authentication.reauthenticate'

export function parseWWWAuthHeader(headerVal: string) {
	const tuples = <[string, string][]> headerVal.split('Bearer ')[1].split(', ').map((x) => x.split('='));
	const wwwAuthMap = new Map<String, string>();

	for (let [key, val] of tuples) {
		wwwAuthMap.set(key, val.replace(/"/g,""));
	}

	return wwwAuthMap;
}

export type SharedAuthToken = SharedWatchableValue<string|null>;

type ReauthFunction = (auth_url: string, used_token?: string|SharedAuthToken) => Promise<string>;

export async function authFetchWithSharedValue(reauthenticate: ReauthFunction, authTokenShared: SharedAuthToken, input: RequestInfo, init = {}, cancelToken: CancellationToken = uncancelableToken, retry = 1): Promise<Response> {
	if (!input) {
		return fetch(input); // to keep the errors consistent
    }
	
	let options = JSON.parse(JSON.stringify(init));

	// handle aborting
	const abortController = new AbortController();
	options.signal = abortController.signal;
	const abort = () => { abortController.abort(); };
    cancelToken.add(abort);
    
    const authToken = authTokenShared!.value;
	
	if (authToken) {
		options.headers = options.headers || new Headers();

		// Headers object seems to be the correct format but a regular object is supported as well
		if (options.headers instanceof Headers) {
			options.headers.append('Authorization', `Bearer ${authToken}`);
		} else {
			options.headers['Authorization'] = `Bearer ${authToken}`;
		}
	}

	return fetch(input, options).then((res) => {
		cancelToken.remove(abort);

		if ([400, 401].includes(res.status)) {
			const wwwAuth = res.headers.get('WWW-Authenticate');

			if (wwwAuth) {
				if (wwwAuth.startsWith('Bearer ')) {
					const wwwAuthMap = parseWWWAuthHeader(wwwAuth);

					if (!wwwAuthMap.get("error") || wwwAuthMap.get("error") === 'invalid_token') {
						// missing or expired
						if (retry > 0) {
							return reauthenticate(<string> wwwAuthMap.get("realm"), authTokenShared).then(() => {
								return authFetchWithSharedValue(reauthenticate, authTokenShared, input, init, cancelToken, retry - 1);
							});
						}
					}

					throw new Error(`status ${res.status} auth error - ${wwwAuthMap.get("error")} + " Reason: ${wwwAuthMap.get("reason")}`);
				}
			}
		}

		return res;
	});	
}
