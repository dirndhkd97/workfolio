import type { Post } from "./domain";

// Fictional editorial examples, not user submissions. Engagement always starts at zero.
export const SAMPLE_POSTS: Post[] = [
  {
    id: "sample-01", category: "빡대가리 게시판", nickname: "첨부파일없는사람",
    title: "첨부파일 확인 부탁드립니다 (첨부파일 없음)",
    body: "메일 보내고 3초 만에 깨달음. 파일을 안 붙임.\n\n‘첨부파일 누락으로 재송부드립니다’ 하고 다시 보냈는데 이번엔 어제 파일임.\n\n세 번째 메일 제목은 그냥 ‘이번엔 진짜입니다’로 할 뻔했다. 오늘 제 뇌는 연차입니다. 이런 날 나만 있는 거 아니지?",
  },
  {
    id: "sample-02", category: "황당한 순간", nickname: "회의실유목민",
    title: "30분 회의하고 정한 것: 다음 회의 날짜",
    body: "회의를 줄이는 방법을 논의하자는 회의에 들어갔음.\n\n각자 의견 듣고, 의견에 대한 의견 듣고, 시간이 부족해짐.\n\n결론은 다음 주에 한 번 더 모여서 이야기하자. 회의가 번식하는 걸 두 눈으로 봤다. 이 회의의 끝은 어디인가.",
  },
  {
    id: "sample-03", category: "회사 사람들", nickname: "점심만진심",
    title: "‘아무거나 먹어요’ 하던 동료의 금지 메뉴 8개",
    body: "점심 뭐 먹을까요? 아무거나 좋대.\n\n국밥은 어제 먹었고, 면은 금방 배고프고, 돈가스는 무겁고, 샐러드는 밥이 아니래.\n\n아무거나라는 식당을 차리면 직장인 상대로 대박 날 것 같음. 메뉴는 매일 사장님 마음대로. 반박 시 도시락.",
  },
  {
    id: "sample-04", category: "웃픈 실수", nickname: "음소거확인요망",
    title: "팀장님한테 ‘우리 애기 맘마 먹자’ 함",
    body: "재택 회의 끝나고 음소거인 줄 알고 고양이한테 ‘우리 애기 맘마 먹자~’ 했는데 마이크가 살아 있었음.\n\n팀장님이 ‘네, 점심 맛있게 드세요’ 하심.\n\n고양이는 밥 먹고 나는 사회적 생명을 조금 잃었다. 내일 카메라는 못 켤 것 같다.",
  },
  {
    id: "sample-05", category: "월급루팡", nickname: "엑셀켜둔사람",
    title: "퇴근 10분 전부터 시계가 고장 나는 현상",
    body: "5시 50분에 시계 보고, 메일 확인하고, 책상 정리하고, 물 한 잔 마시고 다시 봤는데 5시 51분.\n\n점심시간 10분은 30초처럼 지나가면서 퇴근 전 10분은 왜 장편영화임?\n\n다들 퇴근 직전 마지막 10분 어떻게 보내는지 공유 좀. 일단 나는 바탕화면 파일 정리하는 척하면서 더 어지럽히는 중.",
  },
  {
    id: "sample-06", category: "소소한 일상", nickname: "월급날만부자",
    title: "출근은 했는데 영혼은 아직 이불 속",
    body: "몸은 지하철 타고 출근했는데 영혼은 이불에 두고 온 것 같음.\n\n커피 한 잔 마시니까 영혼이 집 앞까지는 나왔다고 연락 옴.\n\n두 잔째부터 합류 예정. 오늘도 책상 앞에 앉은 우리 모두 출석 점수는 만점 줘야 한다.",
  },
].map((entry, index) => ({
  ...entry,
  category: entry.category as Post["category"],
  createdAt: Date.UTC(2026, 10, 12, 8 - index),
  sample: true,
  reactions: { same: 0, laugh: 0, cheer: 0 },
  myReactions: [],
  commentCount: 0,
  mine: false,
}));
