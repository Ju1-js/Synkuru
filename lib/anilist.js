import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import LRU from "lru-cache";
import { getId } from "./id-mapping.js";
import dotenv from "dotenv";
dotenv.config();

const limiter = new Bottleneck({
  maxConcurrent: 5,
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  minTime: 100,
});

limiter.on("error", (error) => {
  console.error("Bottleneck error:", error);
});

let rateLimitPromise = null;
limiter.on("failed", async (error, jobInfo) => {
  if (error.response && error.response.status === 429) {
    const retryAfter = Number(error.response.headers.get("retry-after")) || 60;
    rateLimitPromise = new Promise((resolve) =>
      setTimeout(resolve, retryAfter * 1000)
    );
    await rateLimitPromise;
    rateLimitPromise = null;
    return jobInfo.retryCount < 3 ? retryAfter * 1000 : null;
  }
  throw error;
});

const date = new Date();
const currentSeason = ["WINTER", "SPRING", "SUMMER", "FALL"][
  Math.floor((date.getMonth() / 12) * 4) % 4
];
const currentYear = date.getFullYear();

const cache = new LRU({
  max: 500,
  ttl: 10 * 60 * 1000,
});

const logoCache = new LRU({
  max: 500,
  ttl: 60 * 60 * 1000,
});

function getCacheKey(query, variables) {
  return JSON.stringify({ query, variables });
}

function getCachedResult(query, variables, fetchFn) {
  const key = getCacheKey(query, variables);
  if (cache.has(key)) {
    return cache.get(key);
  }
  const promise = fetchFn()
    .then((data) => {
      cache.set(key, Promise.resolve(data));
      return data;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, promise);
  return promise;
}

async function makeGraphQLRequest(query, variables, token) {
  return limiter.schedule(async () => {
    const endpoint = "https://graphql.anilist.co";
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const options = {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    };

    if (rateLimitPromise) {
      await rateLimitPromise;
    }

    const response = await fetch(endpoint, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(response.statusText + (text ? `: ${text}` : ""));
    }
    const data = await response.json();
    if (data.errors) {
      throw new Error(data.errors.map((e) => e.message).join(", "));
    }
    return data;
  });
}

function logoUrl(hd, normal) {
  const merged = [].concat(hd).concat(normal);
  if (merged.length === 0) return null;
  const logo =
    merged.filter((e) => !e?.lang || ["en", "00"].includes(e.lang))[0] ||
    merged[0];
  return logo?.url ? logo?.url.replace("http://", "https://") : null;
}

async function getLogo(anilistId, type) {
  const cacheKey = `logo_${anilistId}_${type}`;
  if (logoCache.has(cacheKey)) {
    return logoCache.get(cacheKey);
  }
  let tId = null;
  if (type !== "MOVIE") {
    tId = await getId(anilistId, "anilist", "thetvdb");
  } else {
    tId = await getId(anilistId, "anilist", "themoviedb");
  }
  if (!tId) return null;
  const res = await fetch(
    `https://webservice.fanart.tv/v3/${
      type !== "MOVIE" ? "tv" : "movies"
    }/${tId}?api_key=${process.env.FANART_API_KEY}`
  ).then((res) => res.json());
  let url = null;
  if (type !== "MOVIE") url = logoUrl(res.hdtvlogo, res.tvlogo);
  else url = logoUrl(res.hdmovielogo, res.movielogo);
  logoCache.set(cacheKey, url);
  return url;
}

async function getViewer(token) {
  const query = "query{Viewer{id}}";
  const data = await getCachedResult(query, {}, () =>
    makeGraphQLRequest(query, {}, token)
  );
  return data.data.Viewer;
}

async function getUserLists(token) {
  const query =
    "query($userId:Int){MediaListCollection(userId:$userId,type:ANIME,forceSingleCompletedList:true){lists{status,entries{media{id,relations{edges{relationType,node{id}}}}}}}}";
  const user = await getViewer(token);
  if (!user) return [];
  const variables = { userId: user.id };
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  const lists = data.data.MediaListCollection.lists;
  return lists && lists.length ? lists : [];
}

async function getAnilistEntry(name, token) {
  const variables = { search: name, perPage: 1 };
  const query =
    "query($search:String,$perPage:Int){Page(perPage:$perPage,page:1){media(type:ANIME,search:$search){id}}}";
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  return data.data.Page.media[0];
}

async function getAnilistEntryById(id, token) {
  const variables = { mediaId: id };
  const query =
    "query($mediaId:Int){MediaList(mediaId:$mediaId){progress,status,media{episodes}}}";
  const data = await getCachedResult(query, variables, () =>
    makeGraphQLRequest(query, variables, token)
  );
  return data.data.MediaList;
}

async function updateAnilist(id, currentEpisode, preAddedOnly, token) {
  const entry = await getAnilistEntryById(id, token);
  if (preAddedOnly && !entry) return;
  const currentProgress = entry?.progress || 0;
  if (currentProgress >= currentEpisode) return;

  const variables = {
    mediaId: id,
    status: entry?.status,
    progress: currentEpisode,
  };
  if (currentEpisode === entry?.media.episodes) {
    variables.status = "COMPLETED";
  }
  const mutation =
    "mutation($mediaId:Int,$status:MediaListStatus,$progress:Int){SaveMediaListEntry(mediaId:$mediaId,status:$status,progress:$progress){id}}";
  await makeGraphQLRequest(mutation, variables, token);
}

async function getCatalog(catalogType, token) {
  const user = await getViewer(token);
  if (!user) return [];

  let variables = {};
  let query = "";
  catalogType = catalogType.replace(/^SYN_/, "");
  switch (catalogType) {
    case "CURRENT":
      variables = {
        status: ["CURRENT", "REPEATING"],
        sort: "UPDATED_TIME_DESC",
      };
      break;
    case "WATCHING":
      variables = { status: ["CURRENT"], sort: "UPDATED_TIME_DESC" };
      break;
    case "PLANNING":
      const lists = await getUserLists(token);
      const planningIds = lists
        .find((list) => list.status === "PLANNING")
        .entries.flatMap((entry) => entry.media.id);
      variables = {
        id_in: planningIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    case "PAUSED":
      variables = { status: ["PAUSED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "DROPPED":
      variables = { status: ["DROPPED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "COMPLETED":
      variables = { status: ["COMPLETED"], sort: "UPDATED_TIME_DESC" };
      break;
    case "REPEATING":
      variables = { status: ["REPEATING"], sort: "UPDATED_TIME_DESC" };
      break;
    case "SEQUELS": {
      const lists = await getUserLists(token);
      const completedList = lists.find((list) => list.status === "COMPLETED");
      const excludeIds = lists
        .filter((list) =>
          ["CURRENT", "REPEATING", "COMPLETED", "DROPPED", "PAUSED"].includes(
            list.status
          )
        )
        .flatMap((list) => list.entries.map((entry) => entry.media.id));
      const sequelIds = completedList.entries
        .flatMap((entry) =>
          entry.media.relations.edges
            .filter((edge) => edge.relationType === "SEQUEL")
            .map((edge) => edge.node.id)
        )
        .filter((id) => !excludeIds.includes(id));
      variables = {
        id_in: sequelIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    }
    case "STORIES": {
      const lists = await getUserLists(token);
      const completedList = lists.find((list) => list.status === "COMPLETED");
      const excludeIds = lists
        .filter((list) =>
          ["CURRENT", "REPEATING", "COMPLETED", "DROPPED", "PAUSED"].includes(
            list.status
          )
        )
        .flatMap((list) => list.entries.map((entry) => entry.media.id));
      const storyIds = completedList.entries
        .flatMap((entry) =>
          entry.media.relations.edges
            .filter(
              (edge) =>
                !["SEQUEL", "CHARACTER", "OTHER"].includes(edge.relationType)
            )
            .map((edge) => edge.node.id)
        )
        .filter((id) => !excludeIds.includes(id));
      variables = {
        id_in: storyIds,
        status_in: ["FINISHED", "RELEASING"],
        sort: "POPULARITY_DESC",
      };
      break;
    }
    case "POPULAR": {
      variables = {
        sort: "POPULARITY_DESC",
        season: currentSeason,
        year: currentYear,
        format_not: "MUSIC",
      };
      break;
    }
    case "TRENDING":
      variables = { sort: "TRENDING_DESC" };
      break;
    case "ALLPOPULAR":
      variables = { sort: "POPULARITY_DESC" };
      break;
    case "ROMANCE":
    case "ACTION":
    case "ADVENTURE":
    case "FANTASY":
    case "COMEDY":
      variables = { sort: "TRENDING_DESC", genre: [catalogType] };
      break;
    default:
      variables = { status: catalogType };
      break;
  }

  if (variables.status) {
    query =
      "query($userId:Int,$sort:[MediaListSort]){MediaListCollection(userId:$userId,type:ANIME,sort:$sort,forceSingleCompletedList:true){lists{status,entries{media{id,format,status,title{userPreferred},genres,coverImage{extraLarge},bannerImage,description,startDate{year},endDate{year},averageScore,duration,countryOfOrigin,siteUrl}}}}}";
    variables.userId = user.id;
    const status = variables.status;
    delete variables.status;
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const lists = data.data.MediaListCollection.lists;
    const mediaList = lists.reduce((acc, list) => {
      if (status.includes(list.status)) {
        return acc.concat(list.entries);
      }
      return acc;
    }, []);
    const entries = mediaList.map((entry) => entry.media);

    return Promise.all(
      entries.map(async (media) => ({
        id: `anilist:${media.id}`,
        type: media.format === "MOVIE" ? "movie" : "series",
        name: media.title.userPreferred,
        genres: media.genres,
        poster: media.coverImage.extraLarge,
        background: media.bannerImage,
        description: media.description,
        logo: await getLogo(media.id, media.format),
        releaseInfo:
          media.format === "MOVIE"
            ? media.startDate.year
            : media.status === "RELEASING"
            ? `${media.startDate.year}-`
            : media.status === "FINISHED"
            ? media.startDate.year === media.endDate.year
              ? `${media.startDate.year}`
              : `${media.startDate.year}-${media.endDate.year}`
            : media.status === "NOT_YET_RELEASED"
            ? `Coming ${media.startDate.year}`
            : media.status === "CANCELLED"
            ? `Cancelled (${media.startDate.year})`
            : media.status === "HIATUS"
            ? `On Hiatus (${media.startDate.year}${
                media.endDate.year ? `-${media.endDate.year}` : ""
              })`
            : "Unknown",
        imdbRating: media.averageScore / 10,
        released: media.startDate.year
          ? `${media.startDate.year}-${media.startDate.month}-${media.startDate.day}`
          : null,
        runtime: media.duration + "m",
        country: media.countryOfOrigin,
        website: media.siteUrl,
      }))
    );
  } else if (variables.status_in) {
    query =
      "query($status_in:[MediaStatus],$id_in:[Int],$id_not_in:[Int],$sort:[MediaSort]){Page{media(type:ANIME,status_in:$status_in,id_in:$id_in,id_not_in:$id_not_in,format_not:MUSIC,sort:$sort){id,format,status,title{userPreferred},genres,coverImage{extraLarge},bannerImage,description,startDate{year},endDate{year},averageScore,duration,countryOfOrigin,siteUrl}}}";
    variables.id_in = variables.id_in || [];
    variables.id_not_in = variables.id_not_in || [];
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const entries = data.data.Page.media;
    return Promise.all(
      entries.map(async (media) => ({
        id: `anilist:${media.id}`,
        type: media.format === "MOVIE" ? "movie" : "series",
        name: media.title.userPreferred,
        genres: media.genres,
        poster: media.coverImage.extraLarge,
        background: media.bannerImage,
        description: media.description,
        logo: await getLogo(media.id, media.format),
        releaseInfo:
          media.format === "MOVIE"
            ? media.startDate.year
            : media.status === "RELEASING"
            ? `${media.startDate.year}-`
            : media.status === "FINISHED"
            ? media.startDate.year === media.endDate.year
              ? `${media.startDate.year}`
              : `${media.startDate.year}-${media.endDate.year}`
            : media.status === "NOT_YET_RELEASED"
            ? `Coming ${media.startDate.year}`
            : media.status === "CANCELLED"
            ? `Cancelled (${media.startDate.year})`
            : media.status === "HIATUS"
            ? `On Hiatus (${media.startDate.year}${
                media.endDate.year ? `-${media.endDate.year}` : ""
              })`
            : "Unknown",
        imdbRating: media.averageScore / 10,
        released: media.startDate.year
          ? `${media.startDate.year}-${media.startDate.month}-${media.startDate.day}`
          : null,
        runtime: media.duration + "m",
        country: media.countryOfOrigin,
        website: media.siteUrl,
      }))
    );
  } else {
    query =
      "query($sort:[MediaSort],$search:String,$genre:[String],$season:MediaSeason,$year:Int,$format_not:MediaFormat){Page{media(type:ANIME,sort:$sort,search:$search,genre_in:$genre,season:$season,seasonYear:$year,format_not:$format_not){id,format,status,title{userPreferred},genres,coverImage{extraLarge},bannerImage,description,startDate{year},endDate{year},averageScore,duration,countryOfOrigin,siteUrl}}}";
    const data = await getCachedResult(query, variables, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const entries = data.data.Page.media;
    return Promise.all(
      entries.map(async (media) => ({
        id: `anilist:${media.id}`,
        type: media.format === "MOVIE" ? "movie" : "series",
        name: media.title.userPreferred,
        genres: media.genres,
        poster: media.coverImage.extraLarge,
        background: media.bannerImage,
        description: media.description,
        logo: await getLogo(media.id, media.format),
        releaseInfo:
          media.format === "MOVIE"
            ? media.startDate.year
            : media.status === "RELEASING"
            ? `${media.startDate.year}-`
            : media.status === "FINISHED"
            ? media.startDate.year === media.endDate.year
              ? `${media.startDate.year}`
              : `${media.startDate.year}-${media.endDate.year}`
            : media.status === "NOT_YET_RELEASED"
            ? `Coming ${media.startDate.year}`
            : media.status === "CANCELLED"
            ? `Cancelled (${media.startDate.year})`
            : media.status === "HIATUS"
            ? `On Hiatus (${media.startDate.year}${
                media.endDate.year ? `-${media.endDate.year}` : ""
              })`
            : "Unknown",
        imdbRating: media.averageScore / 10,
        released: media.startDate.year
          ? `${media.startDate.year}-${media.startDate.month}-${media.startDate.day}`
          : null,
        runtime: media.duration + "m",
        country: media.countryOfOrigin,
        website: media.siteUrl,
      }))
    );
  }
}

async function handleWatchedEpisode(
  animeName,
  anilistId,
  currentEpisode,
  preAddedOnly,
  token
) {
  if (animeName) {
    const entry = await getAnilistEntry(animeName, token);
    if (entry) {
      await updateAnilist(entry.id, currentEpisode, preAddedOnly, token);
    }
  } else if (anilistId) {
    await updateAnilist(anilistId, currentEpisode, preAddedOnly, token);
  }
}

export { getCatalog, getAnilistEntry, updateAnilist, handleWatchedEpisode };
