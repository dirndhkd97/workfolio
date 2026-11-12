import { receiveKakaoEvent } from '../../../_lib/kakao-events';
import type { CommunityAuthEnv } from '../../../_lib/community-auth';

export const onRequest: PagesFunction<CommunityAuthEnv> = ({ request, env }) => receiveKakaoEvent(request, env);
