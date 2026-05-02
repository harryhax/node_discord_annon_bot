import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  EmbedBuilder
} from "discord.js";
import "dotenv/config";
import {
  colourRoleCommand,
  handleColourRoleInteraction
} from "./modules/colourRole.js";
import {
  handleTuneGameArtists,
  handleTuneGameDecades,
  handleTuneGameGenres,
  handleTuneGameStart,
  handleTuneGameStats,
  handleTuneGameStop,
  tuneGameCommand
} from "./modules/tuneGame.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

/* ============================
   Slash command
============================= */

const commands = [
  new SlashCommandBuilder()
    .setName("anon")
    .setDescription("Send an anonymous message")
    .addStringOption(opt =>
      opt
        .setName("message")
        .setDescription("Anonymous message")
        .setRequired(true)
    ),
  tuneGameCommand,
  colourRoleCommand
].map(c => c.toJSON());

/* ============================
   Register commands (guild)
============================= */

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN
);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("Slash commands registered");
}

/* ============================
   Bot runtime
============================= */

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "tunegame") {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "start") {
      await handleTuneGameStart(interaction);
      return;
    }

    if (subcommand === "stop") {
      await handleTuneGameStop(interaction);
      return;
    }

    if (subcommand === "genres") {
      await handleTuneGameGenres(interaction);
      return;
    }

    if (subcommand === "decades") {
      await handleTuneGameDecades(interaction);
      return;
    }

    if (subcommand === "artists") {
      await handleTuneGameArtists(interaction);
      return;
    }

    if (subcommand === "stats") {
      await handleTuneGameStats(interaction);
      return;
    }

    return;
  }

  if (interaction.commandName === "colourrole") {
    await handleColourRoleInteraction(interaction);
    return;
  }
  if (interaction.commandName !== "anon") return;

  const message = interaction.options.getString("message");

  const anonChannel = await client.channels.fetch(
    process.env.ANON_CHANNEL_ID
  );

  const logChannel = await client.channels.fetch(
    process.env.LOG_CHANNEL_ID
  );

  // send anonymous message
  const sentMessage = await anonChannel.send(
  //  `📨 **Anonymous message:**\n${message}`
   `${message}`
  );

  // build log embed
  const embed = new EmbedBuilder()
    .setAuthor({
      name: interaction.user.username,
      iconURL: interaction.user.displayAvatarURL()
    })
    .setDescription(message)
    .addFields(
      {
        name: "Message ID",
        value: sentMessage.id,
        inline: false
      },
      {
        name: "User ID",
        value: interaction.user.id,
        inline: false
      }
    )
    .setFooter({
      text: new Date().toLocaleString()
    });

  // send log
  await logChannel.send({ embeds: [embed] });

  // acknowledge silently (no visible message)
  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply();
});

client.login(process.env.DISCORD_TOKEN);
