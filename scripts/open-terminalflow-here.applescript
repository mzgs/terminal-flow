use framework "Foundation"
use scripting additions

on run
	set finderPath to my currentFinderPath()
	set encodedPath to my percentEncode(finderPath)
	set changeDirectoryCommand to "builtin cd -- " & quoted form of finderPath
	set encodedCommand to my percentEncode(changeDirectoryCommand)
	open location "terminalflow://new-terminal?cwd=" & encodedPath & "&command=" & encodedCommand
end run

on currentFinderPath()
	tell application "Finder"
		if (count of Finder windows) > 0 then
			set currentFolder to target of front Finder window as alias
		else
			set currentFolder to path to desktop folder as alias
		end if
	end tell

	return POSIX path of currentFolder
end currentFinderPath

on percentEncode(valueToEncode)
	set valueString to current application's NSString's stringWithString:valueToEncode
	set allowedCharacters to current application's NSCharacterSet's characterSetWithCharactersInString:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
	return (valueString's stringByAddingPercentEncodingWithAllowedCharacters:allowedCharacters) as text
end percentEncode
