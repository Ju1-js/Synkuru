const { addonBuilder } = require("stremio-addon-sdk");
const { getNameFromCinemetaId } = require("./lib/cinemeta");
const { getCatalog } = require("./lib/anilist");
const { getAnilistId } = require("./lib/id-mapping");
const { handleWatchedEpisode } = require("./lib/anilist");

const CATALOGS = [
  // { id: "RELEASES", type: "anime", name: "New Releases" }, // Will need to be per RSS feed eventually - NOT IMPLEMENTED YET
  { id: "CURRENT", type: "anime", name: "Continue Watching" },
  { id: "WATCHING", type: "anime", name: "Watching List" },
  { id: "REPEATING", type: "anime", name: "Repeating" },
  { id: "SEQUELS", type: "anime", name: "Sequels You Missed" },
  { id: "STORIES", type: "anime", name: "Stories You Missed" },
  { id: "PLANNING", type: "anime", name: "Planning List" },
  { id: "PAUSED", type: "anime", name: "Paused" },
  { id: "DROPPED", type: "anime", name: "Dropped" },
  { id: "COMPLETED", type: "anime", name: "Completed" },
  { id: "POPULAR", type: "anime", name: "Popular This Season" },
  { id: "TRENDING", type: "anime", name: "Trending Now" },
  { id: "ALLPOPULAR", type: "anime", name: "All Time Popular" },
  { id: "ROMANCE", type: "anime", name: "Romance" },
  { id: "ACTION", type: "anime", name: "Action" },
  { id: "ADVENTURE", type: "anime", name: "Adventure" },
  { id: "FANTASY", type: "anime", name: "Fantasy" },
  { id: "COMEDY", type: "anime", name: "Comedy" },
];

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const builder = new addonBuilder({
  id: "com.Ju1-js.Synkuru",
  version: "0.0.1",
  name: "Synkuru",
  description:
    "Synkuru interfaces with Anilist and allows custom AnimeTosho RSS feeds.",
  background:
    "https://raw.githubusercontent.com/Ju1-js/Synkuru/main//addon-background.jpg",
  logo: "https://raw.githubusercontent.com/Ju1-js/Synkuru/main/addon-logo.png",
  resources: ["catalog", "meta", "subtitles"],
  types: ["anime", "movie", "series"],
  catalogs: CATALOGS,
  idPrefixes: ["anilist", "tt", "kitsu"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    {
      key: "token",
      type: "text",
      title: "Anilist token",
    },
  ],
});

builder.defineSubtitlesHandler(async (args) => {
  const { token, enableSearch, preAddedOnly } = args.config;
  let anilistId = "0";
  let animeName = "";
  let episode = "0";

  if (args.id.startsWith("kitsu")) {
    const [_, id, currEp] = args.id.split(":");
    anilistId = await getAnilistId(id, "kitsu");
    episode = args.type === "movie" ? "1" : currEp;
  } else {
    let [id, seasonName, currEp] = args.id.split(":");
    if (args.type === "movie") {
      anilistId = await getAnilistId(id, "imdb");
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
});

builder.defineCatalogHandler(async (args) => {
  const { token } = args.config;
  const catalog = CATALOGS.find((c) => c.id === args.id);

  if (!catalog) return { metas: [] };

  try {
    const metas = await getCatalog(args.id, token);
    return { metas };
  } catch (error) {
    console.error(`Catalog ${args.id} error:`, error);
    return { metas: [] };
  }
});

module.exports = builder.getInterface();
