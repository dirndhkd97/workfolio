import { cleanupImages, imageFailure, uploadImage, type CommunityImageEnv } from '../../_lib/community-images';
export const onRequest: PagesFunction<CommunityImageEnv> = async ({ request, env, waitUntil }) => {
  if (request.method !== 'POST') return new Response(null, { status:405, headers:{Allow:'POST','Cache-Control':'no-store'} });
  try {
    const response = await uploadImage(request,env);
    waitUntil(cleanupImages(env).catch(() => {}));
    return response;
  } catch (error) { return imageFailure(error); }
};
