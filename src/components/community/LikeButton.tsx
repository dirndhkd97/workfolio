import { useState } from "react";
import { Heart } from "lucide-react";
import type { Post } from "../../lib/community/domain";
import "./LikeButton.css";

interface LikeButtonProps {
  post: Post;
  compact?: boolean;
  disabled: boolean;
  onToggle: (post: Post) => Promise<void> | undefined;
}

const formatCount = new Intl.NumberFormat("ko-KR");

export function LikeButton({ post, compact, disabled, onToggle }: LikeButtonProps) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [motion, setMotion] = useState<"like" | "unlike">();
  const liked = pending ?? post.liked;
  const baseCount = post.likeCount - Number(post.liked);
  const count = baseCount + Number(liked);

  function toggle() {
    if (disabled || pending !== null) return;
    const request = onToggle(post);
    if (!request) return;
    setPending(!post.liked);
    setMotion(post.liked ? "unlike" : "like");
    void request.finally(() => setPending(null));
  }

  return (
    <button
      type="button"
      className={compact ? "like-button like-button--compact" : "like-button"}
      aria-label={`${post.title} 좋아요 ${formatCount.format(count)}개`}
      aria-pressed={liked}
      aria-disabled={disabled || undefined}
      data-motion={motion === (liked ? "like" : "unlike") ? motion : undefined}
      onClick={toggle}
    >
      <span className="like-icon" aria-hidden="true">
        {motion === "like" && liked && (
          <span className="like-burst">
            {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
          </span>
        )}
        <Heart className="like-heart" onAnimationEnd={() => setMotion(undefined)} />
      </span>
      <span>좋아요</span>
      <span className="like-count" aria-hidden="true">
        <span className="like-digits">
          <span>{formatCount.format(baseCount)}</span>
          <span>{formatCount.format(baseCount + 1)}</span>
        </span>
      </span>
    </button>
  );
}
