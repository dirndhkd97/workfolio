import { cleanupImages, discardImage, imageFailure, serveImage, type CommunityImageEnv } from '../../_lib/community-images';
export const onRequest: PagesFunction<CommunityImageEnv> = async ({ request, env, params, waitUntil }) => {
  try {
    if (request.method === 'GET' || request.method === 'HEAD') return await serveImage(request,env,params.id);
    if (request.method === 'DELETE') {
      const response = await discardImage(request,env,params.id);
      waitUntil(cleanupImages(env).catch(() => {}));
      return response;
    }
    return new Response(null,{status:405,headers:{Allow:'GET, HEAD, DELETE','Cache-Control':'no-store'}});
  } catch (error) { return imageFailure(error); }
};
