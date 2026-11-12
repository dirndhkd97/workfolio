import { communityMe, type CommunityAuthEnv } from '../../_lib/community-auth';

export const onRequestGet: PagesFunction<CommunityAuthEnv> = ({ request, env }) => communityMe(request, env);
