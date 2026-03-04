package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"path/filepath"

	"golang.org/x/oauth2"
	"google.golang.org/api/option"
	"google.golang.org/api/youtube/v3"
)

const missingClientSecretsMessage = `
Please configure OAuth 2.0
`

// getClient uses a Context and Config to retrieve a Token
// then generate a Client. It returns the generated Client.
func getClient(ctx context.Context, config *oauth2.Config) *http.Client {
	cacheFile, err := tokenCacheFile()
	if err != nil {
		log.Fatalf("Unable to get path to cached credential file. %v", err)
	}
	tok, err := tokenFromFile(cacheFile)
	if err != nil {
		tok = getTokenFromWeb(config)
		saveToken(cacheFile, tok)
	}
	return config.Client(ctx, tok)
}

// getTokenFromWeb uses Config to request a Token.
// It returns the retrieved Token.
func getTokenFromWeb(config *oauth2.Config) *oauth2.Token {
	authURL := config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	fmt.Printf("Go to the following link in your browser then type the "+
		"authorization code: \n%v\n", authURL)

	var code string
	if _, err := fmt.Scan(&code); err != nil {
		log.Fatalf("Unable to read authorization code %v", err)
	}

	tok, err := config.Exchange(oauth2.NoContext, code)
	if err != nil {
		log.Fatalf("Unable to retrieve token from web %v", err)
	}
	return tok
}

// tokenCacheFile generates credential file path/filename.
// It returns the generated credential path/filename.
func tokenCacheFile() (string, error) {
	usr, err := user.Current()
	if err != nil {
		return "", err
	}
	tokenCacheDir := filepath.Join(usr.HomeDir, ".credentials")
	os.MkdirAll(tokenCacheDir, 0700)
	return filepath.Join(tokenCacheDir,
		url.QueryEscape("youtube-go-quickstart.json")), err
}

// tokenFromFile retrieves a Token from a given file path.
// It returns the retrieved Token and any read error encountered.
func tokenFromFile(file string) (*oauth2.Token, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	t := &oauth2.Token{}
	err = json.NewDecoder(f).Decode(t)
	defer f.Close()
	return t, err
}

// saveToken uses a file path to create a file and store the
// token in it.
func saveToken(file string, token *oauth2.Token) {
	fmt.Printf("Saving credential file to: %s\n", file)
	f, err := os.OpenFile(file, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		log.Fatalf("Unable to cache oauth token: %v", err)
	}
	defer f.Close()
	json.NewEncoder(f).Encode(token)
}

func handleError(err error, message string) {
	if message == "" {
		message = "Error making API call"
	}
	if err != nil {
		log.Fatalf(message+": %v", err.Error())
	}
}

// func channelsListByUsername(service *youtube.Service, part string, forUsername string) {
// 	call := service.Channels.List(part)
// 	call = call.ForUsername(forUsername)
// 	response, err := call.Do()
// 	handleError(err, "")
// 	fmt.Println(fmt.Sprintf("This channel's ID is %s. Its title is '%s', "+
// 		"and it has %d views.",
// 		response.Items[0].Id,
// 		response.Items[0].Snippet.Title,
// 		response.Items[0].Statistics.ViewCount))
// }

func getUploadsPlaylistId(service *youtube.Service, name string) string {
	// service.
	call := service.Channels.List([]string{"contentDetails"})
	call = call.ForUsername(name)
	response, err := call.Do()
	if err != nil {
		panic("Failed to get channel information for LetsPlay")
	}

	for _, channel := range response.Items {
		playlistId := channel.ContentDetails.RelatedPlaylists.Uploads

		fmt.Println("Found playlist ID:", playlistId)
		return playlistId
	}

	return ""
}

func countNumberOfItems(service *youtube.Service, playlistId string) int64 {
	call := service.Playlists.List([]string{"id"})
	call = call.Id(playlistId)
	response, err := call.Do()
	if err != nil {
		log.Fatalln("Failed to fetch channel details", err)
	}

	for _, playlistDetails := range response.Items {
		return playlistDetails.ContentDetails.ItemCount
	}

	return 0
}

func fetchAllVideos(service *youtube.Service, channelName string, playlistId string, count int64) {
	if _, err := os.Stat(channelName); os.IsNotExist(err) {
		os.Mkdir(channelName, os.FileMode(os.O_CREATE))
	}

	pageToken := ""
	i := 1

	for {
		call2 := service.PlaylistItems.List([]string{"snippet"})
		call2 = call2.PlaylistId(playlistId)
		call2 = call2.MaxResults(count)
		if pageToken != "" {
			call2 = call2.PageToken(pageToken)
		}
		response, err := call2.Do()
		if err != nil {
			log.Fatalln("Failed to fetch playlist items")
		}

		playlistItems, err := json.MarshalIndent(response.Items, "", "  ")
		if err != nil {
			log.Fatalln("Failed to marshal playlist items into JSON", err)
		}
		err = os.WriteFile(fmt.Sprintf("%s/playlistItems%d.json", channelName, i), playlistItems, os.ModeAppend)
		if err != nil {
			log.Fatalln("Failed to write JSON to file", err)
		}

		pageToken = response.NextPageToken
		if pageToken == "" {
			break
		}

		i += 1
		fmt.Println("i:", i)
	}
}

/*func main2() {
	ctx := context.Background()

	b, err := os.ReadFile("client_secret.json")
	if err != nil {
		log.Fatalf("Unable to read client secret file: %v", err)
	}

	// If modifying these scopes, delete your previously saved credentials
	// at ~/.credentials/youtube-go-quickstart.json
	config, err := google.ConfigFromJSON(b, youtube.YoutubeReadonlyScope)
	if err != nil {
		log.Fatalf("Unable to parse client secret file to config: %v", err)
	}
	client := getClient(ctx, config)
	service, err := youtube.NewService(ctx, option.WithHTTPClient(client))

	handleError(err, "Error creating YouTube client")

	// channelsListByUsername(service, "snippet,contentDetails,statistics", "GoogleDevelopers")
}*/

func countFetchedVideos(channelName string) {
	entries, err := os.ReadDir(channelName)
	if err != nil {
		log.Fatalln("Failed to read directory", err)
	}

	count := 0

	for _, e := range entries {
		fp := filepath.Join(channelName, e.Name())
		contents, err := os.ReadFile(fp)
		if err != nil {
			log.Fatalln("Failed to read file", fp, err)
		}
		var items []map[string]any
		err = json.Unmarshal(contents, &items)
		if err != nil {
			log.Fatalln("Failed to unmarshal JSON", err)
		}

		count += len(items)
		log.Printf("Found %d items in %s", len(items), fp)
	}

	log.Println("Total count:", count)
}

func main() {
	apiKeyBytes, err := os.ReadFile("apikey.txt")
	if err != nil {
		log.Fatalln("Failed to read API key", err)
	}
	apiKey := string(apiKeyBytes)

	ctx := context.Background()

	service, err := youtube.NewService(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		log.Fatalf("Failed to create Youtube client: %s\n", err)
	}

	channelName := "achievementhunter"

	uploadsId := getUploadsPlaylistId(service, channelName)
	uploadsCount := 8400 // countNumberOfItems(service, uploadsId)

	fmt.Println("Uploads count for", channelName, ":", uploadsCount)

	fetchAllVideos(service, channelName, uploadsId, int64(uploadsCount))

	// countFetchedVideos(channelName)
}
