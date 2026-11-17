import { getCommunityIdentity, type CommunityAuthEnv } from '../_lib/community-auth';
import { recordView, viewJson } from '../_lib/community-views';
import { BoardError, checkMutationRequest, readJsonBody, validPostId } from '../../src/lib/community/domain';

export const onRequestPost: PagesFunction<CommunityAuthEnv> = async ({ request, env }) => {
  try {
    checkMutationRequest(request);
    const data = await readJsonBody(request), userId = await getCommunityIdentity(request, env);
    if (!env.DB) throw new BoardError('저장소를 준비하고 있어요.', 503);
    return await recordView(request, env.DB, validPostId(data.postId), userId);
  } catch (error) {
    return error instanceof BoardError ? viewJson({ error: error.message }, error.status)
      : viewJson({ error: '조회수를 집계하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
  }
};
export const onRequestGet: PagesFunction = async () => new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
