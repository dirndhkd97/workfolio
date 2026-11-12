import { sendCompanyCode, type CommunityCompanyEnv } from '../../_lib/community-company';

export const onRequestPost: PagesFunction<CommunityCompanyEnv> = ({ request, env }) => sendCompanyCode(request, env);
