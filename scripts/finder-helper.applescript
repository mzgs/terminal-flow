use framework "Foundation"
use scripting additions

on folderURL(folderPath)
    set components to current application's NSURLComponents's new()
    components's setScheme:"terminalflow"
    components's setHost:"new-terminal"
    set cwdItem to current application's NSURLQueryItem's queryItemWithName:"cwd" value:folderPath
    components's setQueryItems:{cwdItem}
    -- Form URL decoding treats a literal plus as a space.
    set encodedQuery to components's percentEncodedQuery()
    components's setPercentEncodedQuery:(encodedQuery's stringByReplacingOccurrencesOfString:"+" withString:"%2B")
    return components's |URL|()'s absoluteString() as text
end folderURL

on run
    tell application "Finder"
        if (count of Finder windows) > 0 then
            set folderPath to POSIX path of (target of front Finder window as alias)
        else
            set folderPath to POSIX path of (desktop as alias)
        end if
    end tell
    do shell script "/usr/bin/open -b com.local-terminal.app " & quoted form of my folderURL(folderPath)
end run
