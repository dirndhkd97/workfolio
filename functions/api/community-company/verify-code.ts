import { verifyCompanyCode, type CommunityCompanyEnv } from '../../_lib/community-company';

export const onRequestPost: PagesFunction<CommunityCompanyEnv> = ({ request, env }) => verifyCompanyCode(request, env);
