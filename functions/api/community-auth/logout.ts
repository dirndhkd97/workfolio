import { logoutCommunity, type CommunityAuthEnv } from '../../_lib/community-auth';

export const onRequestPost: PagesFunction<CommunityAuthEnv> = ({ request, env }) => logoutCommunity(request, env);
