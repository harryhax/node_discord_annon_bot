import { REST, Routes, SlashCommandBuilder } from "discord.js";
import "dotenv/config";
import { colourRoleCommand } from "./modules/colourRole.js";
import { tuneGameCommand } from "./modules/tuneGame.js";

const commands = [
  new SlashCommandBuilder()
    .setName("anon")
    .setDescription("Send an anonymous message")
    .addStringOption(opt =>
      opt
        .setName("message")
        .setDescription("Your anonymous message")
        .setRequired(true)
    ),
  tuneGameCommand,
  colourRoleCommand
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("Slash command registered");
})();
