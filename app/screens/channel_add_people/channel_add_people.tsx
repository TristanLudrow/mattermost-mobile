// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {defineMessages, useIntl} from 'react-intl';
import {Keyboard, LayoutChangeEvent, Platform, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {addMembersToChannel} from '@actions/remote/channel';
import {fetchProfilesNotInChannel, searchProfiles} from '@actions/remote/user';
import Loading from '@components/loading';
import Search from '@components/search';
import SelectedUsers from '@components/selected_users';
import UserList from '@components/user_list';
import {General} from '@constants';
import {useServerUrl} from '@context/server';
import {useTheme} from '@context/theme';
import {ChannelModel} from '@database/models/server';
import {debounce} from '@helpers/api/general';
import {useModalPosition} from '@hooks/device';
import {t} from '@i18n';
import {popTopScreen} from '@screens/navigation';
import {alertErrorWithFallback} from '@utils/draft';
import {changeOpacity, getKeyboardAppearanceFromTheme} from '@utils/theme';
import {filterProfilesMatchingTerm} from '@utils/user';

const close = () => {
    Keyboard.dismiss();
    popTopScreen();
};

const style = StyleSheet.create({
    container: {
        flex: 1,
    },
    searchBar: {
        marginLeft: 12,
        marginRight: Platform.select({ios: 4, default: 12}),
        marginVertical: 12,
    },
});

const messages = defineMessages({
    error: {
        id: t('mobile.channel_add_people.error'),
        defaultMessage: 'We could not add those users to the channel. Please check your connection and try again.',
    },
    button: {
        id: t('mobile.channel_add_people.title'),
        defaultMessage: 'Add Members',
    },
    toastMessage: {
        id: t('mobile.channel_add_people.max_limit_reached'),
        defaultMessage: 'Max selected users are limited to {maxCount} members',
    },
});

type Props = {
    componentId: string;
    currentChannel: ChannelModel;
    currentTeamId: string;
    currentUserId: string;
    restrictDirectMessage: boolean;
    teammateNameDisplay: string;
    tutorialWatched: boolean;
}

const MAX_SELECTED_USERS = General.MAX_USERS_ADD_TO_CHANNEL;

function removeProfileFromList(list: {[id: string]: UserProfile}, id: string) {
    const newSelectedIds = Object.assign({}, list);

    Reflect.deleteProperty(newSelectedIds, id);
    return newSelectedIds;
}

export default function ChannelAddPeople({
    // componentId,
    currentChannel,
    currentTeamId,
    currentUserId,
    restrictDirectMessage,
    teammateNameDisplay,
    tutorialWatched,
}: Props) {
    const serverUrl = useServerUrl();
    const intl = useIntl();
    const theme = useTheme();
    const {formatMessage} = intl;

    const searchTimeoutId = useRef<NodeJS.Timeout | null>(null);
    const next = useRef(true);
    const page = useRef(-1);
    const mounted = useRef(false);
    const mainView = useRef<View>(null);
    const modalPosition = useModalPosition(mainView);

    const [profiles, setProfiles] = useState<UserProfile[]>([]);
    const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
    const [loading, setLoading] = useState(false);
    const [term, setTerm] = useState('');
    const [startingAddPeople, setStartingAddPeople] = useState(false);
    const [selectedIds, setSelectedIds] = useState<{[id: string]: UserProfile}>({});
    const [containerHeight, setContainerHeight] = useState(0);
    const [showToast, setShowToast] = useState(false);

    const selectedCount = Object.keys(selectedIds).length;
    const groupConstrained = currentChannel.isGroupConstrained;
    const currentChannelId = currentChannel.id;

    const isSearch = Boolean(term);
    const hasProfiles = useMemo(() => Boolean(profiles.length), [profiles]);

    const loadedProfiles = ({users}: {users: UserProfile[]}) => {
        if (mounted.current) {
            if (users && !users.length) {
                next.current = false;
            }

            page.current += 1;
            setLoading(false);
            setProfiles((prev: UserProfile[]) => [...prev, ...users]);
        }
    };

    const getProfiles = useCallback(debounce(() => {
        if (next.current && !loading && !term && mounted.current) {
            setLoading(true);
            fetchProfilesNotInChannel(serverUrl,
                currentTeamId,
                currentChannelId,
                groupConstrained,
                page.current + 1,
                General.PROFILE_CHUNK_SIZE).then(loadedProfiles);
        }
    }, 100), [loading, isSearch, serverUrl, currentTeamId]);

    const handleRemoveProfile = useCallback((id: string) => {
        setSelectedIds((current) => removeProfileFromList(current, id));
    }, [selectedIds]);

    const addPeopleToChannel = useCallback(async (ids: string[]): Promise<boolean> => {
        const result = await addMembersToChannel(serverUrl, currentChannelId, ids, '', false);

        if (result.error) {
            alertErrorWithFallback(intl, result.error, messages.error);
        }

        return !result.error;
    }, [serverUrl]);

    const clearSearch = useCallback(() => {
        setLoading(false);
        setTerm('');
        setSearchResults([]);
    }, []);

    const startAddPeople = useCallback(async (selectedId?: {[id: string]: boolean}) => {
        if (startingAddPeople) {
            return;
        }

        setStartingAddPeople(true);

        const idsToUse = selectedId ? Object.keys(selectedId) : Object.keys(selectedIds);
        let success;
        if (idsToUse.length === 0) {
            success = false;
        } else {
            success = await addPeopleToChannel(idsToUse);
        }

        if (success) {
            close();
        } else {
            setStartingAddPeople(false);
        }
    }, [startingAddPeople, selectedIds, addPeopleToChannel]);

    const handleSelectProfile = useCallback((user: UserProfile) => {
        clearSearch();
        setSelectedIds((current) => {
            if (current[user.id]) {
                return removeProfileFromList(current, user.id);
            }

            const wasSelected = current[user.id];

            if (!wasSelected && selectedCount >= MAX_SELECTED_USERS) {
                setShowToast(true);
                return current;
            }

            const newSelectedIds = Object.assign({}, current);
            if (!wasSelected) {
                newSelectedIds[user.id] = user;
            }

            return newSelectedIds;
        });
    }, [clearSearch, selectedIds, startAddPeople]);

    const searchUsers = useCallback(async (searchTerm: string) => {
        const lowerCasedTerm = searchTerm.toLowerCase();
        setLoading(true);

        const results = await searchProfiles(serverUrl, lowerCasedTerm, {
            team_id: currentTeamId,
            not_in_channel_id: currentChannel.id,
            allow_inactive: true,
        });

        let data: UserProfile[] = [];
        if (results.data) {
            data = results.data;
        }

        setSearchResults(data);
        setLoading(false);
    }, [restrictDirectMessage, serverUrl, currentTeamId]);

    const search = useCallback(() => {
        searchUsers(term);
    }, [searchUsers, term]);

    const onSearch = useCallback((text: string) => {
        setLoading(true);
        if (text) {
            setTerm(text);
            if (searchTimeoutId.current) {
                clearTimeout(searchTimeoutId.current);
            }

            searchTimeoutId.current = setTimeout(() => {
                searchUsers(text);
            }, General.SEARCH_TIMEOUT_MILLISECONDS);
        } else {
            clearSearch();
        }
    }, [searchUsers, clearSearch]);

    useEffect(() => {
        mounted.current = true;
        getProfiles();
        return () => {
            mounted.current = false;
        };
    }, []);

    useEffect(() => {
        setShowToast(selectedCount >= MAX_SELECTED_USERS);
    }, [selectedCount >= MAX_SELECTED_USERS]);

    const onLayout = useCallback((e: LayoutChangeEvent) => {
        setContainerHeight(e.nativeEvent.layout.height);
    }, []);

    const data = useMemo(() => {
        if (isSearch) {
            const exactMatches: UserProfile[] = [];
            const filterByTerm = (p: UserProfile) => {
                if (selectedCount > 0 && p.id === currentUserId) {
                    return false;
                }

                if (p.username === term || p.username.startsWith(term)) {
                    exactMatches.push(p);
                    return false;
                }

                return true;
            };

            const results = filterProfilesMatchingTerm(searchResults, term).filter(filterByTerm);
            return [...exactMatches, ...results];
        }
        return profiles;
    }, [term, isSearch && selectedCount, isSearch && searchResults, profiles]);

    if (startingAddPeople) {
        return (
            <View style={style.container}>
                <Loading color={theme.centerChannelColor}/>
            </View>
        );
    }

    return (
        <SafeAreaView
            style={style.container}
            testID='add_members.screen'
            onLayout={onLayout}
            edges={['top', 'left', 'right']}
        >
            {hasProfiles &&
                <View style={style.searchBar}>
                    <Search
                        testID='add_members.search_bar'
                        placeholder={intl.formatMessage({id: 'search_bar.search', defaultMessage: 'Search'})}
                        cancelButtonTitle={intl.formatMessage({id: 'mobile.post.cancel', defaultMessage: 'Cancel'})}
                        placeholderTextColor={changeOpacity(theme.centerChannelColor, 0.5)}
                        onChangeText={onSearch}
                        onSubmitEditing={search}
                        onCancel={clearSearch}
                        autoCapitalize='none'
                        keyboardAppearance={getKeyboardAppearanceFromTheme(theme)}
                        value={term}
                    />
                </View>
            }
            <UserList
                currentUserId={currentUserId}
                handleSelectProfile={handleSelectProfile}
                loading={loading}
                profiles={data}
                selectedIds={selectedIds}
                showNoResults={!loading && page.current !== -1}
                teammateNameDisplay={teammateNameDisplay}
                fetchMore={getProfiles}
                term={term}
                testID='add_members.user_list'
                tutorialWatched={tutorialWatched}
            />
            <SelectedUsers
                containerHeight={containerHeight}
                modalPosition={modalPosition}
                showToast={showToast}
                setShowToast={setShowToast}
                toastIcon={'check'}
                toastMessage={formatMessage(messages.toastMessage, {maxCount: MAX_SELECTED_USERS})}
                selectedIds={selectedIds}
                onRemove={handleRemoveProfile}
                teammateNameDisplay={teammateNameDisplay}
                onPress={startAddPeople}
                buttonIcon={'account-plus-outline'}
                buttonText={formatMessage(messages.button)}
            />
        </SafeAreaView>
    );
}
