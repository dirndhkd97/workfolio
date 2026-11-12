import { communityAuthJson, finishCommunityOAuth, isCommunityProvider, type CommunityAuthEnv } from '../../../_lib/community-auth';

export const onRequest: PagesFunction<CommunityAuthEnv> = ({ request, env, params }) => {
  const provider = params.provider;
  return isCommunityProvider(provider) ? finishCommunityOAuth(request, env, provider) : communityAuthJson({ error: '지원하지 않는 로그인 방식이에요.' }, 404);
};
