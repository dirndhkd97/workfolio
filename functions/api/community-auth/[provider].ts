import { communityAuthJson, isCommunityProvider, startCommunityOAuth, type CommunityAuthEnv } from '../../_lib/community-auth';

export const onRequestGet: PagesFunction<CommunityAuthEnv> = ({ request, env, params }) => {
  const provider = params.provider;
  return isCommunityProvider(provider) ? startCommunityOAuth(request, env, provider) : communityAuthJson({ error: '지원하지 않는 로그인 방식이에요.' }, 404);
};
