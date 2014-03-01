var http = require('http'),
	express = require('express'),
	fs = require('fs'),
	googleapis = require('googleapis'),
	OAuth2Client = googleapis.OAuth2Client,
	//secrets and whatnot set through process variables instead of hardcoded to so I don't accidentally commit those, because I've never done that
	oauth2Client = new OAuth2Client(process.env.id, process.env.secret, process.env.redirectUrl);

//initialize various global variables
var googleClient = null, app = express(), clientTokens = [], jsonP, jsonD, currentStatus, currentMessage, currentTime;

app.set('port', process.env.PORT || 8081);
app.use(express.logger('dev'));
app.use(express.json());
app.use(express.urlencoded());
app.use(express.methodOverride());
app.use(app.router);
app.use(express.errorHandler());
app.use('/', express.static(__dirname + '/public')); //allows us to server dir /public statically instead of interpreting it as app input

//see if we currently have any stored auth tokens (read as: "users")
try {
	var filedata = fs.readFileSync(".clienttokens.json");
	if (filedata) clientTokens = JSON.parse(filedata.toString());
} catch(e) {
	console.log("No stored clienttokens: ", e);
}

googleapis.discover('mirror','v1').execute(function(err,client) {
	if (err) {
		console.warn("FAILURE: " + err.toString());
		return;
	}

	googleClient = client;
	checkPRT();

	//if they're trying to get authorized
	app.get('/authorize', function(req, res){
		var oauth2Uri = oauth2Client.generateAuthUrl({
			access_type: 'offline',
			scope: 'https://www.googleapis.com/auth/glass.timeline',
			approval_prompt: 'force'
		});
		res.redirect(oauth2Uri);
	});

	//if they've already been authorized and have returned back to the application from Google
	app.get('/oauth2callback', function(req, res){
		oauth2Client.getToken(req.query.code, function(err,tokens) {
			if (err) {
				res.write("Looks like Google and I aren't getting along right now. Try again in a minute? If that doesn't work, don't worry. I'm probably aware of the problem and am currently working to correct it.");
				console.log("clientToken error: ",err);
				res.end();
			} else {
				clientTokens.push(tokens);
				//google sends the data back to us as json anyways. storing these small tokens into an array in a seperate json file will
				//eliminate the need for a database and having to worry about setting up a database to handle thousands of users if we aren't
				//going to be making any large queries or select pulls from it
				fs.writeFileSync(".clienttokens.json", JSON.stringify(clientTokens,null,"\t"));
				checkPRT();
			}
			res.redirect('/success.html');
		});
	});
});

function checkPRT() {
	console.log("getting PRT");
	var nonce = new Date().getTime();
	var opts = {host:"prtstatus.sitespace.wvu.edu",path:"/cache.php?json=true&callback=func"+nonce,headers:{"Cache-Control":"max-age=0", "User-Agent": "PRT Status on Google Glass"}};
	http.get(opts, function(res) {
		if(res.statusCode == 200){
			res.on('data', function(chunk) {
				jsonP = "", jsonP += chunk;
			});
			res.on('end', function() {
				//apparently the F5 load balancers like to cache various calls. a nonce and timestamped callbacks prevent us from using old data
				if(jsonP.substring(4,17) == nonce){
					//extremely dirty way of extracting the callback a json, I know. I just wasn't aware of any other way to do so.
                    var jsonString = jsonP.substring(jsonP.indexOf('([{')+2, jsonP.indexOf('}])')+1);
                    jsonD = JSON.parse(jsonString);
                    //comparing what we've got to what we had last time. any discrepancies will trigger a card 
                    if(currentStatus != jsonD.status || jsonD.message != currentMessage){
                    	currentStatus = jsonD.status, currentMessage = jsonD.message, currentTime = jsonD.timestamp;
                    	//update (or push anew) users' timeline
						updateNotif(jsonD.status, jsonD.message, jsonD.timestamp);
					}
				} else {
					//see line #77
					console.log("f5 probably cached our call\nJSONP DATA: "+jsonP+"\nNONCE: "+nonce+"\nURL:"+opts.host+opts.path);
				}
			});
		}
	});
}

function updateNotif(statuscode, message, time) {
	var statuscode = (statuscode == 1 ? "PRT is running" : (statuscode==7 ? "PRT is Closed" : (statuscode==5 ? "PRT Alert" : "PRT is DOWN"))), message = message.toString(),
		time = new Date((time*1000)-(5*60*60*1000)).toUTCString().replace(" GMT", "").replace(/[0-2][0-9]:[0-5][0-9]:[0-5][0-9]/, function(a,b){
			var dz = a.split(":");dz[1]+=dz[0] < 12 ? "AM" : "PM";dz[0]=dz[0]%12 || 12;return dz[0]+":"+dz[1];
		});
	for (i = 0; i < clientTokens.length; i++) {
		oauth2Client.credentials = clientTokens[i];
		googleClient.mirror.timeline.list({ "sourceItemId": "prtStatus"}).withAuthClient(oauth2Client)
		.execute(function(err,data) {
			//initializing the landline, a favorite of Walter, and the HTML we're about to insert. I know it's dirty and hacked, but 4AM.
			var apiLandline, html = "<article><section><div class=\"text-auto-size\"><p class=\""+(statuscode.indexOf("running") == 7 ? "green" : "red")+"\">"+statuscode+"</p><p>"+message+"</p></div></section><footer><div>"+time+"</div></footer></article>";
			if (err) console.log("timeline list error: ", err);
			if (data && data.items.length > 0) {
				apiLandline = googleClient.mirror.timeline.patch({"id": data.items[0].id }, {"html": html, "speakableText": message});
				//debugging purposes
				console.log("patched");
				console.log(data);
			} else {
				apiLandline = googleClient.mirror.timeline.insert({
					"html": html,
					"menuItems": [
						{"action":"TOGGLE_PINNED"}, //allows users to pin the PRT status card to the left of their timeline, making it easier to check uptime
						{"action":"READ_ALOUD"}, //this allows the card to be read aloud by Glass, giving you an easier hands-free way of checking PRT status
						{"action":"DELETE"}
					],
					"sourceItemId": "prtStatus",
					"speakableText": message,
					'notification': {'level': 'DEFAULT'}
				});
				console.log("inserted");
			}

			apiLandline.withAuthClient(oauth2Client).execute(function(err,data) {
				console.log("authored client error: ", err, data);
			});
		});
	}
}

//chcecks PRT status every 2 minutes. I might make this every 1 minute in the future, but 2 minutes seems reasonable for now
setInterval(checkPRT, 2*60*1000);

http.createServer(app).listen(app.get('port'), function () {
    console.log('Server listening on port ' + app.get('port'));
}).on('error', function(err){
	//hopefully this fixes that TCP error that happens every once in a blue moon
	console.log("handled thrown error: ", err);
});