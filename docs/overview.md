# Overview

The app instantiates the ShuffleClient class with a collection of coins that need to be shuffled and the uri of the shuffle server.  The client then queries the shuffle server for connection setting and available pools.  If there are coins waiting to be shuffled, the client selects an unshuffled coin and uses it to instantiate a new ShuffleRound.

The new ShuffleRound instance is be saved in the `shuffleClient.rounds` array.  Upon being instantiated, a new communication channel is opened with the server and the pre-shuffle messages take place.  The ShuffleRound instance emits progress events which are be monitored by the ShuffleClient instance so it knows how each round
concludes.

When the round is done, the ShuffleClient instance removes the round from it's array of active rounds.  For a successful round, the client moves the newly shuffled coin into its `shuffled` array.  It moves any new change output back into the unshuffled coin array.  If the round failed, the unshuffled coin is put back into the unshuffled bin so be used in a subsequent round.  Begin again...
