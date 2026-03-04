use dotenv::dotenv;
use reqwest::Client;
use serde_json::{Value, json, to_string_pretty};
use std::{
    env,
    fs::{self, File},
    io::BufReader,
};

static BASE_URL: &str = "https://www.googleapis.com/youtube/v3";

async fn get_uploads_playlist_id(
    api_key: &str,
    name: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let client = Client::new();

    let url = format!(
        "{}/channels?key={}&part={}&forUsername={}",
        BASE_URL, api_key, "contentDetails", name
    );

    // Make request
    let response = client.get(&url).send().await?;
    if !response.status().is_success() {
        return Err(format!(
            "API request failed with status {}: {}",
            response.status(),
            response.text().await?
        )
        .into());
    }

    // Check for API errors
    let json: Value = response.json().await?;
    if let Some(error) = json.get("error") {
        return Err(format!("API returned an error: {:?}", error).into());
    }

    let Some(items) = json["items"].as_array() else {
        return Err("Could not find items on JSON response".into());
    };

    let playlist_id_opt = items[0]["contentDetails"]["relatedPlaylists"]["uploads"].as_str();

    if let Some(playlist_id) = playlist_id_opt {
        return Ok(String::from(playlist_id));
    }
    return Err("Could not find playlist ID in JSON response".into());
}

async fn fetch_all_videos(
    api_key: &str,
    channel_name: &str,
    playlist_id: &str,
    count: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    if !fs::exists(channel_name)? {
        fs::create_dir(channel_name)?;
    }

    let client = Client::new();

    let mut page_token: String = String::new();
    let mut i = 1;

    loop {
        let mut url = format!(
            "{}/playlistItems?key={}&part={}&playlistId={}&maxResults={}",
            BASE_URL, api_key, "snippet", playlist_id, count
        );
        if page_token != "" {
            url = format!("{}&pageToken={}", url, page_token);
        }

        let response = client.get(&url).send().await?;
        if !response.status().is_success() {
            return Err(format!(
                "API request failed with status {}: {}",
                response.status(),
                response.text().await?
            )
            .into());
        }

        // Check for API errors
        let json: Value = response.json().await?;
        if let Some(error) = json.get("error") {
            return Err(format!("API returned an error: {:?}", error).into());
        }

        let Some(items) = json["items"].as_array() else {
            return Err("Could not find items on JSON response".into());
        };

        let playlist_items = to_string_pretty(items)?;
        fs::write(
            format!("{}/playlistItems{}.json", channel_name, i),
            playlist_items,
        )?;

        println!("Fetched {}", i);

        page_token = String::from(json["nextPageToken"].as_str().unwrap_or(""));
        if page_token == "" {
            break;
        }
        i += 1
    }

    Ok(())
}

fn count_fetched_videos(channel_name: &str) -> Result<i64, Box<dyn std::error::Error>> {
    let mut count = 0_i64;

    for entry in fs::read_dir(channel_name)? {
        let entry = entry?;
        let path = entry.path();

        let contents = fs::read_to_string(path)?;
        let json: Value = serde_json::from_str(&contents)?;
        let items = json.as_array().unwrap();

        count += items.len() as i64;
    }

    Ok(count)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv().ok();

    let api_key = env::var("YOUTUBE_API_KEY").expect("YOUTUBE_API_KEY must be set");

    let channel_name = "letsplay";
    // let playlist_id = get_uploads_playlist_id(&api_key, channel_name).await?;
    // println!("playlist ID: {}", playlist_id);
    // fetch_all_videos(&api_key, channel_name, &playlist_id, 4296).await?;
    println!(
        "{} video count: {}",
        channel_name,
        count_fetched_videos(channel_name)?
    );

    Ok(())
}
