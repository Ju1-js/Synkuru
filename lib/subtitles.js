import { getNameFromCinemetaId } from "./cinemeta.js";
import { getId } from "./id-mapping.js";
import { handleWatchedEpisode } from "./anilist.js";

async function processSubtitleRequest(args) {
  const { token, enableSearch, preAddedOnly } = args.config;
  let anilistId = "0";
  let animeName = "";
  let episode = "0";

  if (args.id.startsWith("kitsu")) {
    const [_, id, currEp] = args.id.split(":");
    anilistId = await getId(id, "kitsu", "anilist");
    episode = args.type === "movie" ? "1" : currEp;
  } else {
    let [id, seasonName, currEp] = args.id.split(":");
    if (args.type === "movie") {
      anilistId = await getId(id, "imdb", "anilist");
      episode = "1";
    } else if (enableSearch) {
      const season = parseInt(seasonName);
      animeName = await getNameFromCinemetaId(id, args.type);
      if (animeName && season > 1) {
        animeName += ` ${season}`;
      }
      episode = currEp;
    }
  }

  if ((animeName || anilistId) && episode) {
    try {
      await handleWatchedEpisode(
        animeName,
        parseInt(anilistId),
        parseInt(episode),
        preAddedOnly,
        token
      );
    } catch (err) {
      console.error(err);
    }
  }
  return Promise.resolve({ subtitles: [] });
}

export { processSubtitleRequest };
