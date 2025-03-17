const Anilist = require("anilist-node");

async function getCatalog(catalogType, token) {
  const anilistApi = new Anilist(token);
  const currentUser = await anilistApi.user.getAuthorized();
  const userLists = await anilistApi.lists.anime(currentUser.id);

  const list = userLists.find((item) => item.status === catalogType);

  if (!list) return [];

  return list.entries.map(({ media }) => ({
    id: "anilist:" + media.id,
    type: media.format === "MOVIE" ? "movie" : "series",
    name: media.title.userPreferred,
    poster: media.coverImage.medium,
    description: media.description,
    genres: media.gennres,
    imdbRating: media.score,
  }));
}

async function handleWatchedEpisode(
  animeName,
  anilistId,
  currentEpisode,
  preAddedOnly,
  token
) {
  if (animeName) {
    const anilistEntry = await getAnilistEntry(animeName, token);
    if (anilistEntry) {
      await updateAnilist(anilistEntry.id, currentEpisode, preAddedOnly, token);
    }
  } else if (anilistId) {
    await updateAnilist(anilistId, currentEpisode, preAddedOnly, token);
  }
}

async function getAnilistEntry(name, token) {
  const anilistApi = new Anilist(token);
  const response = await anilistApi.searchEntry.anime(name, undefined, 1, 1);
  const results = response.media;
  if (Array.isArray(results) && results.length > 0) {
    return results[0];
  }
}

async function updateAnilist(id, currentEpisode, preAddedOnly, token) {
  const anilistApi = new Anilist(token);
  const currAnime = await anilistApi.media.anime(id);

  if (preAddedOnly && !currAnime.mediaListEntry) return;

  const currProgress = currAnime.mediaListEntry
    ? currAnime.mediaListEntry.progress
    : 0;
  if (
    currProgress >= currentEpisode ||
    (currAnime.episodes != null && currentEpisode > currAnime.episodes)
  )
    return;

  await anilistApi.lists.addEntry(id, {
    progress: currentEpisode,
    status: currentEpisode === currAnime.episodes ? "COMPLETED" : "CURRENT",
  });
}

async function alRequest(query, variables, token) {
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: query.replace(/\s+/g, " ").trim(),
      variables: {
        page: 1,
        perPage: 50,
        ...variables,
      },
    }),
  };

  if (token) {
    options.headers.Authorization = `${token}`;
  }

  const response = await fetch("https://graphql.anilist.co", options);
  return response.json();
}

const statusMap = {
  CURRENT: "CURRENT",
  PLANNING: "PLANNING",
  COMPLETED: "COMPLETED",
  DROPPED: "DROPPED",
  PAUSED: "PAUSED",
  REPEATING: "REPEATING",
};

const getCatalog = async (catalogId, token) => {
  try {
    let query,
      variables = {};

    switch (catalogId) {
      case "SEQUELS":
      case "STORIES":
        const relationsQuery = `query ($page: Int, $perPage: Int) {
          MediaListCollection(userName: $userName, type: ANIME, status: COMPLETED) {
            lists {
              entries {
                media {
                  relations {
                    edges {
                      relationType
                      node { id }
                    }
                  }
                }
              }
            }
          }
        }`;

        const relationsData = await anilistClient(
          alRequest(relationsQuery, {}, token)
        );
        // Process relations data and create ID list
        break;

      case "CURRENT":
        query = `query ($page: Int, $perPage: Int) {
          MediaListCollection(userName: $userName, type: ANIME, status: CURRENT) {
            lists {
              entries {
                media { id title { romaji } }
              }
            }
          }
        }`;
        break;

      // Add similar cases for other catalog types

      case "POPULAR":
        variables.sort = "POPULARITY_DESC";
        variables.season = getCurrentSeason();
        variables.year = new Date().getFullYear();
        break;

      case "TRENDING":
        variables.sort = "TRENDING_DESC";
        break;

      case "ROMANCE":
      case "ACTION":
      case "ADVENTURE":
      case "FANTASY":
      case "COMEDY":
        variables.genre = [catalogId];
        variables.sort = "TRENDING_DESC";
        break;
    }

    const response = await anilistClient(alRequest(query, variables, token));
    return processResponse(response);
  } catch (error) {
    console.error("AniList error:", error);
    return [];
  }
};

function processResponse(response) {
  // Convert AniList response to Stremio metas format
  return response.data.Page.media.map((media) => ({
    id: media.id,
    type: "anime",
    name: media.title.romaji,
    genres: media.genres,
    poster: media.coverImage.large,
  }));
}

module.exports = {
  handleWatchedEpisode,
  getCatalog,
  alRequest,
};
