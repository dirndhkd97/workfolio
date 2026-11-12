import { companyMe, type CommunityCompanyEnv } from '../../_lib/community-company';

export const onRequestGet: PagesFunction<CommunityCompanyEnv> = ({ request, env }) => companyMe(request, env);
