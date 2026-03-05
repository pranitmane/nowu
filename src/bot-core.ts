//main context -> this is for telegram bot
//we have to setup a webhook that fetches the latest messages from the user with id xxxxx and then we process the message 
//while processing it we have to check if the message is a command or not and then we have to check if the command is valid or not and then we have to execute the command and then we have to send the response back to the user
//we dont need express as we are not exposing any endpoints to the outside world we are just fetching the messages from the user and then processing them and then sending the response back to the user
//requirements first lets just fetch the message and send ack back

//which library should we use for telegram bot development? there are many libraries available for telegram bot development in nodejs like telegraf, node-telegram-bot-api, etc. but we will use telegraf as it is the most popular and widely used library for telegram bot development in nodejs